# ToolBoard GPT - Plugin Copilot para Miro

## Descripción del proyecto

ToolBoard GPT es un prototipo de AI Copilot con supervisión humana (Human-in-the-loop) integrado en el entorno de pizarras Miro, diseñado para asistir el análisis de proyectos y la mejora de contenidos dentro de la metodología de emprendimiento ToolBoard.

Este proyecto es un MVP / PoC cuyo objetivo es validar la viabilidad del sistema ToolBoard GPT en el entorno de Miro. La versión actual implementa los flujos de interacción principales sin desarrollar la totalidad de las Tools de la metodología ToolBoard.

El sistema lee `Frames` y `Sticky Notes` del canvas de Miro mediante Miro Web SDK v2 y combina:

- Contexto estructurado del canvas actual
- Base de conocimiento metodológico ToolBoard (RAG)
- Inferencia mediante modelos OpenAI

para proporcionar al usuario sugerencias y diagnósticos relacionados con la Tool activa, la pregunta focal y el estado global del tablero.

Las funcionalidades principales del MVP son:

- `Preview`  
  Lee y previsualiza el contenido estructurado que el sistema ha identificado en el canvas, sin invocar IA generativa.

- `Analyse`  
  Genera sugerencias contextualizadas para la Tool y la pregunta actualmente seleccionadas. Por defecto devuelve 3 sugerencias; cuando la pregunta contiene varias sub-preguntas, el número puede aumentar dinámicamente hasta 4 o 5.

- `Project Review`  
  Realiza un diagnóstico global de todo el canvas ToolBoard en dos fases:
  1. Progreso rápido y foco recomendado
  2. Coherencia lógica y análisis de calidad de tarjetas

- `Professional Rewrite`  
  Reescribe profesionalmente una Sticky Note indicada, optimizando la formalidad, la claridad y la densidad informativa de la expresión.

El alcance de pruebas principal se centra en los contenidos de Tool 0, 1 y 2. Los documentos de conocimiento de Tool 3 a Tool 9 ya existen en la base de conocimiento, pero no constituyen el rango de pruebas principal en esta fase.

## Estructura de directorios

```text
poc-miro-gpt/
├─ src/
│  ├─ app.js                  # Lógica principal del frontend (panel Miro, lectura del canvas, visualización y escritura de sugerencias)
│  ├─ questions.js            # QUESTION_BANK: mapeo estructurado de Tools y preguntas
│  ├─ index.js                # Punto de entrada del frontend
│  ├─ assets/                 # Recursos estáticos
│  └─ server/
│     ├─ index.js             # Servidor Express del backend y todas las API
│     ├─ .env                 # Variables de entorno del backend (configurar manualmente)
│     ├─ assistant-memory.json# Memoria local ligera (recentInteractions, mapeo de threads)
│     ├─ package.json         # Dependencias del backend
│     ├─ knowledge/           # Documentos de conocimiento RAG originales (.docx / .pdf)
│     ├─ chroma/              # Datos persistentes locales de ChromaDB
│     └─ rag/
│        ├─ ingest.js         # Script de ingestión de la base de conocimiento
│        └─ retriever.js      # Módulo de recuperación semántica
├─ app.html                   # HTML de entrada del plugin Miro
├─ index.html                 # Página por defecto
├─ vite.config.js             # Configuración de Vite (puerto frontend: 3000)
├─ package.json               # Dependencias y scripts del frontend
├─ scripts/
│  └─ dev-all.js              # Script para arrancar frontend y backend simultáneamente
└─ start.bat                  # Inicio con un clic en Windows
```

## Requisitos del entorno

| Dependencia | Versión requerida | Descripción |
|-------------|-------------------|-------------|
| Node.js | >= 18 | Entorno de ejecución para frontend y backend |
| npm | >= 9 | Gestor de paquetes |
| Python | >= 3.8 | Necesario si se usa ChromaDB mediante pip |
| ChromaDB | >= 0.4 | Base de datos vectorial local, debe iniciarse por separado |
| OpenAI API Key | Válida | Para llamadas al modelo y generación de embeddings |
| Docker | Disponible | Recomendado en Windows para iniciar ChromaDB |

## Instalación de dependencias

Ejecutar desde la raíz del repositorio:

```bash
npm install
npm --prefix src/server install
```

## Configuración del `.env`

El backend requiere el archivo `src/server/.env`. Si no existe, crearlo manualmente:

```env
OPENAI_API_KEY=sk-your-openai-api-key-here
CHROMA_URL=http://127.0.0.1:8000
CHROMA_COLLECTION=toolboard_kb
```

| Variable | Descripción |
|----------|-------------|
| `OPENAI_API_KEY` | Clave de API de OpenAI, usada para generación de sugerencias, reescritura, detección de idioma y embeddings |
| `CHROMA_URL` | Dirección del servicio ChromaDB, por defecto `http://127.0.0.1:8000` |
| `CHROMA_COLLECTION` | Nombre de la colección ChromaDB, por defecto `toolboard_kb` |

> No incluir el archivo `.env` con claves reales en el repositorio Git. La configuración actual está orientada a desarrollo local y no está endurecida para producción.

## Iniciar ChromaDB

ChromaDB debe ejecutarse como servicio independiente; el backend accede a él mediante HTTP.

**Método Docker (recomendado):**

```powershell
docker.exe run -d -p 8000:8000 chromadb/chroma
```

Verificar que el contenedor está en ejecución:

```powershell
docker.exe ps
```

Si aparece el mapeo de puertos `0.0.0.0:8000->8000/tcp`, ChromaDB ha arrancado correctamente.

**Método pip:**

```bash
chroma run --path src/server/chroma --port 8000
```

Si PowerShell indica que no reconoce `chroma`, usar el método Docker.

## Ejecutar la ingestión RAG de la base de conocimiento

Ejecutar la primera vez, o tras actualizar los documentos en `src/server/knowledge/`. Requisitos previos: ChromaDB en marcha y `.env` configurado.

```bash
npm --prefix src/server run ingest
```

El script lee los archivos `.docx`, `.pdf`, `.txt` y `.md` del directorio `knowledge/`, los divide en fragmentos de aproximadamente 900 caracteres, genera vectores con `text-embedding-3-small` y los escribe en la colección ChromaDB `toolboard_kb`.

Archivos actuales de la base de conocimiento:

```text
src/server/knowledge/
├─ Tool0_Instrucciones.docx
├─ Tool1_Instrucciones.docx
├─ Tool2_Instrucciones.docx
├─ Tool3_Instrucciones.docx
├─ Tool4_Instrucciones.docx
├─ Tool5_Instrucciones.docx
├─ Tool6_Instrucciones.docx
├─ Tool7_Instrucciones.docx
├─ Instrucciones_Excel.docx           # Tool 8
├─ Tool9_Instrucciones_.docx          # Tool 9
├─ Esquemas_Toolboard.pdf
├─ Prompt_ToolboardGPT_actualizado.docx
└─ libro_pdf_viajeemprendedor (1).pdf
```

## Iniciar el backend

```bash
cd src/server
node index.js
```

El backend escucha por defecto en `http://localhost:8787`. Principales endpoints de la API:

| Endpoint | Funcionalidad |
|----------|---------------|
| `POST /api/suggest` | `Analyse`: genera sugerencias contextualizadas |
| `POST /api/refine` | `Professional Rewrite`: reescribe una Sticky Note indicada |
| `POST /api/diagnose` | `Project Review` fase 1: progreso, diagnóstico y foco recomendado |
| `POST /api/diagnose/details` | `Project Review` fase 2: auditoría lógica y análisis de calidad de tarjetas |
| `POST /api/thread/sync` | Sincroniza la interacción actual en la memoria local ligera |

## Iniciar el frontend

```bash
npm start
```

El servidor de desarrollo Vite escucha en `http://localhost:3000`. El punto de entrada del plugin Miro es `http://localhost:3000/app.html`.

## Forma de arranque recomendada

Para el desarrollo diario, ejecutar directamente desde la raíz del repositorio:

```bash
npm run dev:all
```

Esto arranca simultáneamente el frontend (`npm start`) y el backend (`node src/server/index.js`). En Windows también se puede hacer doble clic en:

```bat
start.bat
```

> Antes de usar cualquiera de estas opciones, asegurarse de que ChromaDB ya está iniciado por separado.

## Flujo de ejecución local completo

Secuencia de arranque recomendada en Windows PowerShell (primera configuración):

```powershell
# 1. Instalar dependencias (solo la primera vez)
npm install
npm --prefix src/server install

# 2. Iniciar ChromaDB
docker.exe run -d -p 8000:8000 chromadb/chroma

# 3. Ejecutar ingestión RAG (solo la primera vez, o tras actualizar la base de conocimiento)
npm --prefix src/server run ingest

# 4. Arrancar frontend + backend
npm run dev:all
```

Tras el arranque: frontend en `http://localhost:3000`, backend en `http://localhost:8787`, entrada del plugin en `http://localhost:3000/app.html`.

## Registro y uso del plugin en Miro

### 1. Crear una Miro App

Abrir [https://developers.miro.com/](https://developers.miro.com/) y crear una nueva App indicando el nombre de la App y el Team al que pertenece.

### 2. Configurar la App URL

En la página de configuración de la App, establecer la `App URL` como:

```text
http://localhost:3000/app.html
```

### 3. Configurar permisos e instalar

En `All plans` seleccionar los dos primeros permisos y hacer clic en `Install app and get OAuth token` para completar la instalación.

### 4. Subir la plantilla y abrir el plugin

Subir el archivo de plantilla Miro `Toolboard Canvas EN (1).rtb` al mismo Team. Una vez abierto, hacer clic en el icono `+` de la barra de herramientas izquierda, buscar el nombre de la App recién creada, localizarla bajo la categoría `Tools` y hacer clic para usarla.

> El servicio local (`npm run dev:all`) debe permanecer en ejecución durante el uso del plugin.

## Orden de prueba de funcionalidades

1. `Preview`: confirmar que el sistema puede leer los Frames y Sticky Notes del canvas
2. `Analyse`: seleccionar una pregunta en Tool 0–2, confirmar que se generan sugerencias contextualizadas
3. `Project Review`: confirmar que el sistema devuelve progreso, foco recomendado, auditoría lógica y análisis de calidad de tarjetas
4. `Professional Rewrite`: seleccionar una Sticky Note y confirmar que el sistema puede reescribirla profesionalmente

## Notas sobre la implementación actual

- La generación principal de sugerencias en `Analyse` usa `gpt-4o-mini`; tareas auxiliares como la detección de idioma y la realineación de sugerencias usan `gpt-4o`
- La fuente principal de contexto es el contenido en tiempo real del canvas de Miro; el campo `recentInteractions` en `assistant-memory.json` aporta continuidad ligera entre sesiones
- El OpenAI Thread cumple una función de archivo complementario y no participa en la cadena principal de generación de sugerencias
- Las salidas de la IA son contenido candidato; todas las operaciones de escritura en el canvas requieren confirmación explícita del usuario
- La configuración actual está orientada a entorno de desarrollo local y no está endurecida para producción
