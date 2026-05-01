## ToolBoard GPT Miro Plugin

Miro plugin integrated with ToolBoard GPT.

### Current architecture

This repository uses a three-layer structure:

- Frontend: root `src/`, running in the Miro panel with Vite on `http://localhost:3000`
- Backend: `src/server/`, Express API on `http://localhost:8787`
- RAG: `src/server/rag/`, responsible for ingestion and retrieval with ChromaDB

### Source of truth

- Active application code lives in the root `src/` directory
- The legacy duplicate `poc-miro-gpt/` app tree has been removed from the active setup

### Project structure

```text
.
|-- src
|   |-- app.js
|   |-- index.js
|   |-- questions.js
|   |-- assets
|   `-- server
|       |-- index.js
|       |-- knowledge
|       |-- chroma
|       `-- rag
|           |-- ingest.js
|           `-- retriever.js
|-- app.html
|-- index.html
|-- package.json
`-- scripts
    `-- dev-all.js
```

### Install dependencies

```bash
npm install
npm --prefix src/server install
```

### Run everything

Use one command from the repository root:

```bash
npm run dev:all
```

Or on Windows:

```bat
start.bat
```

This starts:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8787`

### Run separately

```bash
# terminal 1
cd src/server
node index.js

# terminal 2
npm start
```

### Rebuild the knowledge base

The current ingestion flow is manual and performs a full rebuild.

```bash
npm --prefix src/server run ingest
```

Chroma persistence lives in `src/server/chroma/`.
