// src/server/rag/toolFlow.js

export const TOOL_FLOW = [
  { step: 0, file: "Tool0_Instrucciones.docx" },
  { step: 1, file: "Tool1_Instrucciones.docx" },
  { step: 2, file: "Tool2_Instrucciones.docx" },
  { step: 3, file: "Tool3_Instrucciones.docx" },
  { step: 4, file: "Tool4_Instrucciones.docx" },
  { step: 5, file: "Tool5_Instrucciones.docx" },
  { step: 6, file: "Tool6_Instrucciones.docx" },
  { step: 7, file: "Tool7_Instrucciones.docx" },
  { step: 8, file: "Instrucciones_Excel.docx" },
  { step: 9, file: "Tool9_Instrucciones_.docx" },
];

export const BACKGROUND_FILES = [
  "Esquemas_Toolboard.pdf",
  "libro_pdf_viajeemprendedor.pdf",
];

export function getFileByStep(step) {
  const tool = TOOL_FLOW.find((t) => t.step === step);
  return tool ? tool.file : null;
}

export function getNextStep(currentStep) {
  const next = TOOL_FLOW.find((t) => t.step === currentStep + 1);
  return next ? next.step : null;
}