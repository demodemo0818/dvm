import { LucideProvider } from "lucide-react";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

/**
 * アイコンは Lucide に統一する(v1.13)。絵文字はフォントによって字幅・線の太さ・
 * カラー/白黒がばらつき、Windows では意図せずカラー絵文字で描かれて浮いていた。
 * 大きさと線の太さはここで 1 回だけ決め、呼び出し側では指定しない。
 * 色は stroke="currentColor" なので、既存の hover / .active の CSS がそのまま効く。
 */
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LucideProvider size={16} strokeWidth={1.75}>
      <App />
    </LucideProvider>
  </React.StrictMode>,
);
