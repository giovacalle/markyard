// Loaded through import() only when a note contains math, so KaTeX costs nothing otherwise.
import "katex/dist/katex.min.css";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

export { rehypeKatex, remarkMath };
