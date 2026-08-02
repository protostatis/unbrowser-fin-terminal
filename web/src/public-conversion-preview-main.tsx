import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PublicConversionPreview } from "./PublicConversionPreview";
import "./styles.css";
import "./public-conversion-preview.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

createRoot(root).render(
  <StrictMode>
    <PublicConversionPreview />
  </StrictMode>,
);
