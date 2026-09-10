import { env } from '../config/env';
import { shellQuote } from './gh-cli-runner';
import type { WorkspaceRunner } from './runner';
import {
  DeepSeekClient,
  type DeepSeekMessage,
  type DeepSeekTool,
  DeepSeekError,
} from '../agent/models/providers/DeepSeekClient';

const MAX_TOOL_OUTPUT = 6000;
const MAX_FILE_CHARS = 20000;

const BLOCKED_COMMAND_PATTERNS = [
  /rm\s+-rf\s+\/(?:\s|$)/,
  /mkfs\./,
  /:\(\)\s*\{/,
  /dd\s+if=.*of=\/dev\//,
  /shutdown|reboot|halt/,
  />\s*\/dev\/sd[a-z]/,
];

export interface DeepSeekCoderRequest {
  runner: WorkspaceRunner;
  codespaceName: string;
  workdir: string;
  task: string;
  model?: string;
  maxSteps?: number;
  notify?: (text: string) => Promise<void>;
}

export interface DeepSeekCoderResult {
  summary: string;
  steps: number;
  actions: string[];
  filesTouched: string[];
}

export function buildCoderTools(): DeepSeekTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'Lista los archivos rastreados por Git en el repositorio. Úsalo para orientarte.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Filtro opcional, por ejemplo "src/" o ".ts".' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Lee el contenido de un archivo del repositorio.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Ruta relativa al repositorio.' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Escribe o reemplaza por completo el contenido de un archivo. Es la forma de aplicar cambios.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Ruta relativa al repositorio.' },
            content: { type: 'string', description: 'Contenido completo y final del archivo.' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Ejecuta un comando de shell dentro del repositorio. Úsalo para tests, builds o git.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'Comando a ejecutar.' } },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish',
        description: 'Termina la tarea. Llámalo solo cuando los cambios estén hechos.',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Resumen en texto plano: qué cambiaste y qué comprobaste.' },
          },
          required: ['summary'],
        },
      },
    },
  ];
}

export function buildCoderSystemPrompt(): string {
  return [
    'Eres un ingeniero de software trabajando dentro de un Codespace real.',
    'Resuelves la tarea modificando archivos del repositorio con las herramientas disponibles.',
    'Reglas:',
    '- Lee antes de escribir: no inventes el contenido de un archivo que no has leído.',
    '- Al escribir, envía el archivo completo y final, no fragmentos ni parches.',
    '- Modifica solo lo necesario para cumplir la tarea.',
    '- Ejecuta los tests o comprobaciones disponibles con run_command.',
    '- No hagas commit ni push: de eso se encarga otro sistema.',
    '- Cuando termines, llama a finish con un resumen en texto plano.',
    'Responde siempre en español.',
  ].join('\n');
}

export function isPathInsideWorkdir(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('~')) return false;
  return !path.split(/[\\/]/).includes('..');
}

export function isBlockedCommand(command: string): boolean {
  return BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function truncateToolOutput(text: string, limit = MAX_TOOL_OUTPUT): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n…[salida truncada]`;
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Ejecuta una tarea de código con DeepSeek usando el Codespace como entorno. */
export async function runDeepSeekCodingTask(
  request: DeepSeekCoderRequest,
  client = new DeepSeekClient(),
): Promise<DeepSeekCoderResult> {
  const model = request.model ?? env.deepseekAgentModel;
  const maxSteps = request.maxSteps ?? env.deepseekAgentMaxSteps;
  const tools = buildCoderTools();
  const actions: string[] = [];
  const filesTouched = new Set<string>();

  const messages: DeepSeekMessage[] = [
    { role: 'system', content: buildCoderSystemPrompt() },
    {
      role: 'user',
      content: [
        `Tarea: ${request.task}`,
        '',
        `Trabajas dentro del directorio del repositorio en el Codespace.`,
        'Empieza listando los archivos si necesitas orientarte.',
      ].join('\n'),
    },
  ];

  for (let step = 1; step <= maxSteps; step += 1) {
    const response = await client.chat(messages, { model, tools, temperature: 0.1 });

    if (response.toolCalls.length === 0) {
      return {
        summary: response.content.trim() || 'El modelo terminó sin resumen.',
        steps: step,
        actions,
        filesTouched: [...filesTouched],
      };
    }

    messages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      const args = parseToolArguments(call.function.arguments);

      if (call.function.name === 'finish') {
        const summary = typeof args.summary === 'string' ? args.summary : 'Tarea completada.';
        actions.push('finish');
        await request.notify?.(`🏁 El agente terminó: ${summary.split('\n')[0].slice(0, 160)}`);
        return { summary, steps: step, actions, filesTouched: [...filesTouched] };
      }

      const outcome = await executeTool(request, call.function.name, args, filesTouched);
      actions.push(`${call.function.name}: ${outcome.label}`);
      await request.notify?.(outcome.notice);
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.output });
    }
  }

  throw new DeepSeekError(
    `El agente alcanzó el límite de ${maxSteps} pasos sin terminar. Últimas acciones: ${actions.slice(-4).join(' | ')}`,
    'UPSTREAM_ERROR',
  );
}

interface ToolOutcome {
  output: string;
  notice: string;
  label: string;
}

async function executeTool(
  request: DeepSeekCoderRequest,
  name: string,
  args: Record<string, unknown>,
  filesTouched: Set<string>,
): Promise<ToolOutcome> {
  const { runner, codespaceName, workdir } = request;

  if (name === 'list_files') {
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    const command = pattern
      ? `git ls-files | grep -F ${shellQuote(pattern)} | head -200`
      : 'git ls-files | head -200';
    const result = await runner.execute(codespaceName, `${command} || true`, { workdir });
    return {
      output: truncateToolOutput(result.output) || '(sin archivos)',
      notice: '',
      label: pattern || 'todos',
    };
  }

  if (name === 'read_file') {
    const path = String(args.path ?? '');
    if (!isPathInsideWorkdir(path)) {
      return { output: `Ruta no permitida: ${path}`, notice: '', label: `rechazado ${path}` };
    }
    const result = await runner.execute(
      codespaceName,
      `if [ -f ${shellQuote(path)} ]; then head -c ${MAX_FILE_CHARS} ${shellQuote(path)}; else echo "__NO_EXISTE__"; fi`,
      { workdir },
    );
    const output = result.output.trim();
    return {
      output: output === '__NO_EXISTE__' ? `El archivo ${path} no existe.` : truncateToolOutput(output),
      notice: '',
      label: path,
    };
  }

  if (name === 'write_file') {
    const path = String(args.path ?? '');
    const content = typeof args.content === 'string' ? args.content : '';
    if (!isPathInsideWorkdir(path)) {
      return { output: `Ruta no permitida: ${path}`, notice: '', label: `rechazado ${path}` };
    }
    if (!content) {
      return { output: 'No enviaste contenido para el archivo.', notice: '', label: `vacío ${path}` };
    }
    const payload = Buffer.from(content, 'utf8').toString('base64');
    const result = await runner.execute(
      codespaceName,
      [
        `mkdir -p "$(dirname ${shellQuote(path)})"`,
        `printf %s ${shellQuote(payload)} | base64 -d > ${shellQuote(path)}`,
        `echo "ESCRITO $(wc -c < ${shellQuote(path)}) bytes"`,
      ].join(' && '),
      { workdir },
    );
    if (result.exitCode !== 0) {
      return {
        output: `No pude escribir ${path}: ${truncateToolOutput(result.output, 500)}`,
        notice: `⚠️ No pude escribir ${path}`,
        label: `error ${path}`,
      };
    }
    filesTouched.add(path);
    return {
      output: `Archivo ${path} escrito correctamente.`,
      notice: `✏️ Editado ${path}`,
      label: path,
    };
  }

  if (name === 'run_command') {
    const command = String(args.command ?? '').trim();
    if (!command) return { output: 'Comando vacío.', notice: '', label: 'vacío' };
    if (isBlockedCommand(command)) {
      return {
        output: `Comando bloqueado por seguridad: ${command}`,
        notice: `🚫 Bloqueé un comando peligroso`,
        label: 'bloqueado',
      };
    }
    const result = await runner.execute(codespaceName, `${command} 2>&1`, {
      workdir,
      timeoutMs: env.codespaceGitTimeoutMs,
    });
    return {
      output: truncateToolOutput(
        `exit=${result.exitCode}${result.timedOut ? ' (timeout)' : ''}\n${result.output}`,
      ),
      notice: `⚙️ Ejecutado: ${command.slice(0, 120)}`,
      label: command.slice(0, 80),
    };
  }

  return { output: `Herramienta desconocida: ${name}`, notice: '', label: 'desconocida' };
}
