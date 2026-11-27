import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, LanguageSupport } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { describe, expect, it } from "vite-plus/test";
import { matchCodeLanguage } from "./editorCodeLanguages";

function parseFencedDoc(doc: string) {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, codeLanguages: matchCodeLanguage })],
  });
  const tree = ensureSyntaxTree(state, state.doc.length, 5_000);
  if (!tree) {
    throw new Error("Syntax tree did not finish parsing");
  }
  return { state, tree };
}

function nodeChainAt(doc: string, needle: string): string[] {
  const { tree } = parseFencedDoc(doc);
  const offset = doc.indexOf(needle);
  if (offset < 0) {
    throw new Error(`Needle ${JSON.stringify(needle)} not found in doc`);
  }
  const names: string[] = [];
  for (
    let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(offset, 1);
    node;
    node = node.parent
  ) {
    names.push(node.name);
  }
  return names;
}

function highlightedTokens(doc: string): Array<{ text: string; classes: string }> {
  const { tree } = parseFencedDoc(doc);
  const tokens: Array<{ text: string; classes: string }> = [];
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    tokens.push({ text: doc.slice(from, to), classes });
  });
  return tokens;
}

describe("matchCodeLanguage", () => {
  it.each([
    ["js", "JavaScript"],
    ["JS", "JavaScript"],
    ["javascript", "JavaScript"],
    ["jsx", "JSX"],
    ["ts", "TypeScript"],
    ["TypeScript", "TypeScript"],
    ["tsx", "TSX"],
    ["json", "JSON"],
    ["jsonc", "JSON"],
    ["html", "HTML"],
    ["HTML", "HTML"],
    ["css", "CSS"],
    ["python", "Python"],
    ["py", "Python"],
    ["yaml", "YAML"],
    ["yml", "YAML"],
    ["query", "YAML"],
    ["QUERY", "YAML"],
    ["sql", "SQL"],
    ["bash", "Shell"],
    ["sh", "Shell"],
    ["shell", "Shell"],
    ["zsh", "Shell"],
    ["lua", "Lua"],
    ["go", "Go"],
    ["golang", "Go"],
    ["rust", "Rust"],
    ["rs", "Rust"],
    ["md", "Markdown"],
    ["markdown", "Markdown"],
    ["ts title=example.ts", "TypeScript"],
  ])("matches %j to %s", (info, expectedName) => {
    const desc = matchCodeLanguage(info);
    expect(desc?.name).toBe(expectedName);
  });

  it.each(["", "   ", "text", "plaintext", "txt", "mermaid", "unknown-language-xyz"])(
    "returns null for plain text or unknown info %j",
    (info) => {
      expect(matchCodeLanguage(info)).toBeNull();
    },
  );
});

describe("lazy fenced code block parsing", () => {
  it("highlights yaml and query blocks synchronously using bundled YAML support", () => {
    const yamlDesc = matchCodeLanguage("yaml");
    const queryDesc = matchCodeLanguage("query");
    expect(yamlDesc).not.toBeNull();
    expect(queryDesc).toBe(yamlDesc);
    expect(yamlDesc?.support).toBeInstanceOf(LanguageSupport);

    const doc = '```query\nfrom: "notes"\nlimit: 10\n```\n';
    expect(nodeChainAt(doc, "from")).toContain("Key");
    expect(nodeChainAt(doc, "10")).toContain("Pair");

    const tokens = highlightedTokens(doc);
    expect(tokens).toContainEqual({
      text: "from",
      classes: expect.stringContaining("tok-propertyName"),
    });
    expect(tokens).toContainEqual(
      expect.objectContaining({ text: '"notes"', classes: "tok-string" }),
    );
    expect(tokens).toContainEqual({
      text: "limit",
      classes: expect.stringContaining("tok-propertyName"),
    });
  });

  it("loads TypeScript lazily and parses tokens inside a fenced code block", async () => {
    const tsDesc = matchCodeLanguage("typescript");
    expect(tsDesc).not.toBeNull();

    const support = await tsDesc!.load();
    expect(support).toBeInstanceOf(LanguageSupport);

    const doc = '```ts\n// sample\nconst answer: number = 42;\nconst label = "ok";\n```\n';
    expect(nodeChainAt(doc, "const answer")).toContain("VariableDeclaration");
    expect(nodeChainAt(doc, "42")).toContain("Number");
    expect(nodeChainAt(doc, '"ok"')).toContain("String");

    const tokens = highlightedTokens(doc);
    expect(tokens).toContainEqual(
      expect.objectContaining({ text: "// sample", classes: "tok-comment" }),
    );
    expect(tokens).toContainEqual(
      expect.objectContaining({ text: "const", classes: "tok-keyword" }),
    );
    expect(tokens).toContainEqual(expect.objectContaining({ text: "42", classes: "tok-number" }));
    expect(tokens).toContainEqual(expect.objectContaining({ text: '"ok"', classes: "tok-string" }));
  });

  it("loads Python, Bash, and Lua lazily and highlights tokens in fenced code blocks", async () => {
    const pyDesc = matchCodeLanguage("py");
    const bashDesc = matchCodeLanguage("bash");
    const luaDesc = matchCodeLanguage("lua");
    expect(pyDesc).not.toBeNull();
    expect(bashDesc).not.toBeNull();
    expect(luaDesc).not.toBeNull();

    const [pySupport, bashSupport, luaSupport] = await Promise.all([
      pyDesc!.load(),
      bashDesc!.load(),
      luaDesc!.load(),
    ]);
    expect(pySupport).toBeInstanceOf(LanguageSupport);
    expect(bashSupport).toBeInstanceOf(LanguageSupport);
    expect(luaSupport).toBeInstanceOf(LanguageSupport);

    const pyDoc = '```python\ndef greet(name):\n    return "hi"\n```\n';
    expect(nodeChainAt(pyDoc, "def greet")).toContain("FunctionDefinition");
    expect(highlightedTokens(pyDoc)).toContainEqual(
      expect.objectContaining({ text: "def", classes: "tok-keyword" }),
    );
    expect(highlightedTokens(pyDoc)).toContainEqual(
      expect.objectContaining({ text: '"hi"', classes: "tok-string" }),
    );

    const bashDoc = '```bash\nif [ -f "README.md" ]; then echo "ok"; fi\n```\n';
    expect(highlightedTokens(bashDoc)).toContainEqual(
      expect.objectContaining({ text: "if", classes: "tok-keyword" }),
    );
    expect(highlightedTokens(bashDoc)).toContainEqual(
      expect.objectContaining({ text: '"README.md"', classes: "tok-string" }),
    );

    const luaDoc = "```lua\nlocal count = 3\nreturn count\n```\n";
    expect(highlightedTokens(luaDoc)).toContainEqual(
      expect.objectContaining({ text: "local", classes: "tok-keyword" }),
    );
    expect(highlightedTokens(luaDoc)).toContainEqual(
      expect.objectContaining({ text: "3", classes: "tok-number" }),
    );
  });
});
