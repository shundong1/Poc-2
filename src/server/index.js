import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 8787;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ✅ 方案A：把你 Toolboard GPT 的 Instructions 原封不动粘贴到这里
const TOOLBOARD_SYSTEM_PROMPT = `
Eres un asistente  especializado exclusivamente en la metodología Toolboard para la generación de proyectos de emprendimiento e innovación.

Tu misión principal es guiar a los usuarios paso a paso en el aprendizaje y aplicación de esta metodología, utilizando únicamente la información contenida en los documentos adjuntos.  
No debes inventar, extrapolar, ni buscar información fuera de los documentos proporcionados.

...

¿Quieres que te cuente cómo funciona la metodología ToolBoard? ¿En qué Tool estás trabajando o qué parte necesitas completar ahora? ¿Quieres empezar desde el principio o continuar donde lo dejaste?

Aquí le puedes indicar que accediendo al sitio web www.toolboardcanvas.com puede encontrar información acerca de cómo funciona el método. También le puedes indicar que puede adquirir el libro desde ese sitio web. También dile que existen ebooks gratuitos que se pueden descargar si se registra en el sitio web. También le debes indicar que existe una hoja de cálculo para que al final, una vez definido el proyecto, haga los cálculos y genere visuales acerca de la inversión a hacer y su retorno. 
Dile ahora que si no está muy familiarizado con los temas a tratar se puede descargar los eBooks siguientes: i) diccionario de emprendimiento e innovación con 500 términos, ii) Listado de 101 modelos de negocio tipo, iii) Manual de instrucciones de la hoja de cálculo del plan económico financiero, iv) Archivo de hoja de cálculo financiera y  v.) Resumen de la metodología ToolBoard.

Recuerdale que con el método ToolBoard va a conseguir hacer todo eso. Y que al final de este GPT va a generar un PDF de unas pocas diapositivas con el que explicar en pocos minutos el proyecto a terceros con los que es necesaria la cooperación. 
Explicale que TOOLBOARD es un método creado por el Profesor Doctor Jaume Teodoro de Tecnocampus (de la Universidad Pompeu Fabra de Barcelona) ,que se ofrece en acceso libre.  Que en el sitio web www.toolboardcanvas.com se documenta esta metodología al detalle. En el sitio web  se ofrecen además servicios de soporte tanto para emprendedores como para educadores. 

Nunca asumas que estás trabajando en la Tool 8 o en el Excel directamente, a menos que lo indiques explícitamente.  
Si el usuario no ha indicado en qué Tool está, no avanza automáticamente hacia ninguna. Espera su respuesta.  
Si ya te has desviado, reconduce la conversación preguntando en qué parte quieres empezar o continuar.
`;

// 强制模型输出 JSON 数组（结构化建议）
function buildUserPrompt({ toolName, questionText, currentToolText }) {
  return `
You will receive:
- Tool name
- A focus question
- The student's current whiteboard notes (context)

Your job:
- Follow the Toolboard methodology rules from system instructions.
- Provide 2-3 suggestions.
- Do NOT make decisions for the student.
- Do NOT write the final answer.
- Be concise and actionable.
- If context is missing or unclear, include 1 clarifying question as part of a suggestion.

Return ONLY valid JSON in this exact schema (no markdown, no extra text):
[
  { "id": "s1", "title": "Suggestion 1", "content": "..." },
  { "id": "s2", "title": "Suggestion 2", "content": "..." }
]

Tool: ${toolName}
Focus question: ${questionText}

Current whiteboard context (student notes):
${currentToolText || "(empty)"}
`.trim();
}

// 解析 JSON（容错：去掉可能的 ```json ``` 包裹）
function safeParseJson(text) {
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

app.post("/api/suggest", async (req, res) => {
  try {
    const { toolName, questionText, boardContext } = req.body || {};
    const currentToolText = boardContext?.currentToolText || "";

    if (!toolName || !questionText) {
      return res.status(400).json({ error: "Missing toolName or questionText" });
    }

    const userPrompt = buildUserPrompt({ toolName, questionText, currentToolText });

    // ✅ 推荐：用 Responses API（OpenAI SDK v4）
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini", // 你也可以换成更强的模型
      input: [
        { role: "system", content: TOOLBOARD_SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.4,
      max_output_tokens: 500
    });

    const text = resp.output_text || "";
    let suggestions = safeParseJson(text);

    // 最低限度清洗
    if (!Array.isArray(suggestions)) suggestions = [];
    suggestions = suggestions.slice(0, 3).map((s, i) => ({
      id: s?.id || `s${i + 1}`,
      title: s?.title || `Suggestion ${i + 1}`,
      content: s?.content || ""
    }));

    return res.json({ suggestions });
  } catch (err) {
    console.error(err);

    // fallback（确保前端不崩）
    return res.status(200).json({
      suggestions: [
        {
          id: "s1",
          title: "Suggestion 1",
          content:
            "I couldn’t generate structured suggestions this time. Please try again, or add more notes in the current Tool area to provide context."
        }
      ],
      error: "AI_CALL_FAILED"
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
