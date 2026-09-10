# Telegram Dev Agent

MVP de comunicación bidireccional entre Telegram, un agente conversacional y Google Gemini desde GitHub Codespaces. El agente solo analiza y conversa: todavía no ejecuta comandos ni modifica repositorios.

## Requisitos

- Node.js 20 o superior
- Un bot de Telegram creado con `@BotFather`
- Una API key de Gemini desde [Google AI Studio](https://aistudio.google.com/app/apikey)
- Un Codespace abierto para este repositorio

## Instalación

```bash
npm install
cp .env.example .env
```

Edita `.env` y configura el token de Telegram. No guardes ese archivo en Git:

```dotenv
PORT=3000
TELEGRAM_BOT_TOKEN=token_entregado_por_BotFather
TELEGRAM_WEBHOOK_SECRET=secreto_largo_opcional
TELEGRAM_WEBHOOK_URL=https://TU-CODESPACE.app.github.dev/telegram/webhook
AUTHORIZED_TELEGRAM_USER_IDS=123456789
MODEL_PROVIDER=gemini
GEMINI_API_KEY=clave_de_google_ai_studio
GEMINI_MODEL=gemini-2.5-flash-lite
GITHUB_TOKEN=token_de_github
AGENT_MEMORY_FILE=.data/agent-contexts.json
AGENT_PERSONALITY=profesional, claro, proactivo y práctico
```

`AUTHORIZED_TELEGRAM_USER_IDS` es opcional y acepta IDs separados por comas. Si queda vacío, cualquier usuario que encuentre el bot podrá interactuar con él. Para obtener tu ID, envía `/start` al bot y revisa temporalmente el payload recibido o usa un bot de consulta de ID. El token real solo debe existir en `.env` o en los secretos del entorno.

## Configurar Telegram

1. En Telegram, abre `@BotFather`, ejecuta `/newbot` y copia el token que entrega.
2. Pon ese token en `TELEGRAM_BOT_TOKEN` dentro de `.env`.
3. Publica el puerto `3000` de Codespaces y configura `TELEGRAM_WEBHOOK_URL` con su URL pública terminada en `/telegram/webhook`.
4. Arranca la aplicación con `npm run dev`. El servidor registra el webhook automáticamente:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
	-H 'Content-Type: application/json' \
	-d '{"url":"https://<URL_PUBLICA_DEL_CODESPACE>/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>"}'
```

5. Abre tu bot y envía `/start` o cualquier mensaje. La aplicación responderá mediante Telegram.

El endpoint utilizado por Telegram es `POST /telegram/webhook`. El endpoint antiguo `POST /webhook` de WhatsApp se conserva como adaptador compatible, pero Telegram es el canal principal.

## Configurar Gemini

1. Abre Google AI Studio y crea una API key.
2. Copia la clave únicamente a `.env` como `GEMINI_API_KEY`. No la pongas en el código, README ni Git.
3. Define `GEMINI_MODEL`. El valor recomendado para este MVP es `gemini-2.5-flash-lite`, orientado a respuestas rápidas y al uso dentro de las cuotas gratuitas disponibles.
4. Mantén `MODEL_PROVIDER=gemini`.

El proyecto no configura facturación, Vertex AI ni proveedores de pago automáticamente. El uso de cualquier API está sujeto a las cuotas y condiciones vigentes de Google; revisa tu cuenta antes de usarla de forma continuada.

## Ejecutar en Codespaces

Servidor de desarrollo con recarga:

```bash
npm run dev
```

También están disponibles:

```bash
npm run build
npm start
npm test
```

El servidor escucha en `0.0.0.0` y usa el puerto definido por `PORT` o `3000`. En el panel **Ports** de Codespaces, haz público el puerto `3000` y copia su URL pública. No uses `localhost` como URL de callback de Meta.

## Probar

Comprobaciones locales:

```bash
curl http://localhost:3000/
curl http://localhost:3000/health
curl http://localhost:3000/health
```

Para probar recepción real, envía un mensaje desde un usuario autorizado (o cualquier usuario si la lista está vacía) al bot de Telegram. El flujo será:

```text
Telegram -> POST /telegram/webhook -> Agent -> ModelRouter -> GeminiProvider -> Gemini API
																			|
Telegram <- sendMessage <--------------------------------------------------+
```

El agente enviará la respuesta generada por Gemini mediante Telegram Bot API. Si falta `GEMINI_API_KEY`, el webhook devuelve un error controlado y no realiza ninguna llamada al modelo.

Para probar `/repos`, configura `GITHUB_TOKEN` en `.env` y reinicia la aplicación. Usa un token con acceso de lectura a los repositorios que quieras consultar. La GitHub App continúa soportada para las futuras operaciones de escritura, commits, push y pull requests.

La conversación y el repositorio seleccionado se guardan en `AGENT_MEMORY_FILE`, con historial limitado. `AGENT_PERSONALITY` permite ajustar el tono del agente sin cambiar el código.

### Comandos de repositorios en Telegram

Después de seleccionar un repositorio con `/repo nombre`, puedes usar:

```text
/help
/repos
/repo nombre-o-owner/nombre
/repo-status
/branches
/readme
/file ruta/al/archivo
/issues
/prs
/context
/analiza nombre
/status
/plan
/aceptar
/cancelar
/review
```

Las respuestas de archivos se limitan para que entren en Telegram. Para solicitar un cambio, selecciona un repositorio y escribe la petición en lenguaje natural. El agente configurado en el Codespace generará el plan y esperará `/aceptar` o `/cancelar`.

### Informe de análisis

`analiza` (o `/analiza`, `informe`, `cómo está construido`, `arquitectura`) devuelve primero una **ficha determinista** construida solo con datos reales de GitHub: identidad del proyecto, stack, estructura de primer nivel, tipos de archivo, puntos de entrada, scripts, dependencias, cómo se ejecuta, pruebas, documentación y riesgos observables. Debajo añade la narrativa del modelo. Si el modelo falla, el informe llega igual.

### Implementar y publicar cambios

El flujo completo es:

1. Escribe la petición (por ejemplo: `actualiza el README`). Recibes un plan y la rama de trabajo propuesta.
2. `/aceptar` implementa los cambios en el Codespace y te envía el resumen del agente.
3. `aceptarcambiosysubiragthub` implementa si hace falta, hace `git add -A`, `git commit`, `git push` a una rama `agent/<fecha>` y abre el pull request.

También se aceptan las variantes `aceptar cambios y subir a github`, `aceptarcambiosysubir`, `publicarcambios` y `/subir`.

El progreso se envía por mensajes separados (`🔧 implementando`, `📤 subiendo`, `🔀 abriendo PR`), así que puedes seguir escribiendo mientras trabaja. Un chat solo puede tener una tarea en curso a la vez. Al terminar recibes el commit, la lista de archivos modificados, la URL del pull request y el diff adjunto como documento.

Configura el bridge del agente instalado en el Codespace. Solo se usa si **no** hay `DEEPSEEK_API_KEY`:

```env
CODESPACE_PLANNER_COMMAND=./scripts/agent-bridge plan
CODESPACE_AGENT_COMMAND=./scripts/agent-bridge run
CODESPACE_COPILOT_MODEL=DeepSeek V4.1 Flash
```

Si prefieres Copilot CLI, estos valores funcionan. **No añadas barras invertidas delante de las comillas**: el comando se envía tal cual al Codespace y los escapes rompen el `base64 -d`.

```env
CODESPACE_PLANNER_COMMAND=copilot --silent --no-ask-user --plan --model "$CODESPACE_COPILOT_MODEL" -p "$(printf %s "$AGENT_TASK_B64" | base64 -d)"
CODESPACE_AGENT_COMMAND=copilot --silent --no-ask-user --allow-all-tools --allow-all-paths --autopilot --model "$CODESPACE_COPILOT_MODEL" -p "$(printf %s "$AGENT_TASK_B64" | base64 -d)"
```

`AGENT_TASK_B64` y `CODESPACE_COPILOT_MODEL` se exportan automáticamente en el Codespace antes de ejecutar el comando, así que no hace falta definirlos allí.

`CODESPACE_COPILOT_MODEL` debe coincidir exactamente con el nombre que Copilot muestra en su selector. Empieza con `auto` (funciona siempre) y cámbialo cuando confirmes el nombre exacto del modelo DeepSeek disponible en tu cuenta; si el nombre no coincide, Copilot CLI falla y verás el error en el chat. El bridge puede envolver Copilot CLI, Claude Code, Codex CLI, Gemini CLI u otro servicio, pero debe escribir su respuesta en stdout.

### Escritura en GitHub

Las operaciones de escritura están desactivadas de forma explícita y requieren dos cosas a la vez:

```env
ALLOW_WRITE_OPERATIONS=true
AGENT_BRANCH_PREFIX=agent/
AGENT_COMMIT_NAME=AI Development Agent
AGENT_COMMIT_EMAIL=ai-agent@users.noreply.github.com
```

1. `ALLOW_WRITE_OPERATIONS=true` en el entorno.
2. Un plan aprobado: el agente concede permisos de escritura solo durante la operación concreta y los revoca al terminar.

### Un único lugar de trabajo

El agente trabaja siempre en **un solo Codespace**, el de `GITHUB_CODESPACES_NAME`. Antes de cada implementación nueva:

1. Si quedaban cambios sin subir de la implementación anterior, hace `git add -A`, `git commit` y `git push` a la rama de esa implementación. Si ese push falla, **no borra nada** para no perder el trabajo y te avisa.
2. Borra todo el contenido de `GITHUB_CODESPACES_WORKDIR`.
3. Clona el repositorio seleccionado en `GITHUB_CODESPACES_WORKDIR/<nombre-del-repo>`.

Solo se limpia esa carpeta, y únicamente si está dentro de `/workspaces`. La configuración del Codespace (`~/.gitconfig`, credenciales de `gh`, Copilot CLI) y el directorio propio del Codespace no se tocan.

```env
GITHUB_CODESPACES_NAME=crispy-orbit-9pqww9rvp69cp675
GITHUB_CODESPACES_WORKDIR=/workspaces/agent-workspace
```

El `push` lo ejecuta el Codespace con la credencial de `gh` ya autenticada allí (`gh auth setup-git`). El pull request se intenta crear primero con la GitHub App; si la App no tiene el permiso **Pull requests: write**, se abre automáticamente con `gh pr create` desde el Codespace y te lo indica en el mensaje.

Los timeouts son configurables para que ninguna orden se quede colgada: `CODESPACE_PLAN_TIMEOUT_MS`, `CODESPACE_IMPLEMENT_TIMEOUT_MS`, `CODESPACE_REVIEW_TIMEOUT_MS` y `CODESPACE_GIT_TIMEOUT_MS`.

## Modelos: reparto entre Gemini y DeepSeek

Hay **dos proveedores a la vez**, y `ModelRouter` decide cuál usa cada petición según el `taskType`:

| Tarea | `taskType` | Quién responde |
|---|---|---|
| Charla libre (ningún comando coincide) | `GENERAL` | conversacional |
| Narrativa de `/analiza` (la ficha la hace TypeScript) | `ARCHITECTURE` | conversacional |
| Plan de cambio | `PLANNING` | principal |
| Implementar cambios | bucle de herramientas, va directo | principal |
| Revisión | `REVIEW` | principal |

```env
MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=tu-clave-de-platform.deepseek.com

CONVERSATIONAL_PROVIDER=gemini
CONVERSATIONAL_TASKS=GENERAL,ARCHITECTURE
GEMINI_API_KEY=tu-clave-de-google-ai
```

Así Gemini lleva la conversación (rápido y barato) y DeepSeek se reserva para planificar y escribir código. Si el proveedor conversacional falla, el router **cae automáticamente al principal** en vez de romper el chat. Con `CONVERSATIONAL_PROVIDER=none` todo pasa por el principal, y quitando `ARCHITECTURE` de `CONVERSATIONAL_TASKS` el informe del repositorio también lo haría DeepSeek.

Los comandos de lectura (`/repos`, `/repo`, `/branches`, `/readme`, `/file`, `/issues`, `/prs`, `/context`, `/status`, `/plan`) **no usan ningún modelo**: son API de GitHub y plantillas de texto en TypeScript.

### Cómo implementa cambios

`DEEPSEEK_API_KEY` activa un agente de código propio. Funciona así:

1. El servidor envía la tarea y el plan aprobado al modelo.
2. El modelo pide herramientas: `list_files`, `read_file`, `write_file` y `run_command`.
3. El servidor ejecuta esas herramientas **dentro del Codespace**, en el directorio del repositorio.
4. El bucle continúa hasta que el modelo llama a `finish`, y después se hace add, commit y push.

Como el bucle vive en el servidor, no hay que instalar nada en el Codespace: solo necesita `git` y el shell. Las escrituras se limitan al repositorio (nada de `/etc` ni `..`) y los comandos destructivos como `rm -rf /` se bloquean.

Si no defines `DEEPSEEK_API_KEY`, se usa `CODESPACE_AGENT_COMMAND` como bridge externo (Copilot CLI u otro).

### Alternativa con Gemini

```env
MODEL_PROVIDER=gemini
GEMINI_API_KEY=tu-clave
```

Gemini Flash funciona bien para conversación y análisis rápido. Para planes complejos y generación de código es mejor DeepSeek.

Un modelo instalado como extensión de VS Code (por ejemplo `vizards.deepseek-v4-for-copilot`) **solo es usable desde el chat de VS Code**: no expone ningún endpoint que el servidor pueda llamar. La extensión usa la API oficial de DeepSeek, así que la misma clave de `platform.deepseek.com` sirve para el agente.

Un modelo configurado dentro de un Codespace no queda disponible automáticamente para este servidor. Debe exponer una API autenticada. El `WorkspaceProvider` se encargará del workspace, herramientas y tests, mientras el modelo recibe contexto controlado sin secretos.

### Acceso GitHub completo

Para la GitHub App, el `.env` efectivo debe contener las tres variables siguientes, además de la private key:

```env
GITHUB_APP_ID=4
GITHUB_INSTALLATION_ID=numero-de-la-instalacion
GITHUB_APP_PRIVATE_KEY=contenido-del-archivo-pem
```

La private key sola no permite autenticar la instalación. La clave puede pegarse en base64 DER sin cabeceras PEM: el servidor la normaliza a PEM al arrancar.

Los tests usan `supertest`, clientes mockeados y un runner de Codespace simulado; no envían mensajes reales, no tocan GitHub y no necesitan una API key.

## Estructura

```text
src/
	agent/agent.ts
	agent/context.ts
	agent/jobs.ts
	agent/orchestrator.ts
	agent/models/provider.ts
	agent/models/router.ts
	agent/models/provider-factory.ts
	agent/models/providers/GeminiProvider.ts
	agent/prompts/system.ts
	config/env.ts
	channels/types.ts
	github/client.ts
	github/permissions.ts
	github/project-report.ts
	github/repository-context.ts
	github/repository-manager.ts
	github/types.ts
	telegram/client.ts
	telegram/format.ts
	telegram/types.ts
	telegram/webhook.ts
	whatsapp/client.ts          # adaptador compatible
	whatsapp/types.ts           # adaptador compatible
	whatsapp/webhook.ts         # adaptador compatible
	workspace/gh-cli-runner.ts
	workspace/git-operations.ts
	workspace/github-codespaces.ts
	workspace/runner.ts
	workspace/types.ts
	modules/types.ts
	modules/network/index.ts
	modules/voice/index.ts
	modules/music/index.ts
	modules/messaging/index.ts
	modules/calls/index.ts
	server.ts
tests/
```

La idempotencia usa `MemoryMessageIdStore`, con una interfaz que puede sustituirse después por Redis o PostgreSQL. `channels/types.ts` desacopla el agente del canal. `agent/jobs.ts` limita a una tarea simultánea por chat y envía las notificaciones de progreso. `telegram/format.ts` limpia el Markdown y divide los mensajes largos para respetar el límite de Telegram.

Los módulos `network`, `voice`, `music`, `messaging` y `calls` son puntos de extensión reservados y todavía no ejecutan acciones. `ModelProvider` y `ModelRouter` permiten añadir otros proveedores y tipos de tarea (`GENERAL`, `PLANNING`, `ARCHITECTURE`, `CODING`, `REVIEW`) posteriormente.

Todavía no se implementan: captura de pantalla y audio de los cambios, creación automática de Codespaces nuevos, persistencia en PostgreSQL/Redis, cola durable que sobreviva a un reinicio, y despliegues.
