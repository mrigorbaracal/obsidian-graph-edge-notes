# Graph Edge Notes (Dynamic Fork)

Fork do plugin [obsidian-graph-edge-notes](https://github.com/li-zane/obsidian-graph-edge-notes) com suporte a expressões dinâmicas nos labels das arestas.

## Demo

### Graph view

![Graph edge notes color demo](docs/assets/graph-colors-demo.gif)

### Frontmatter setup

![Graph edge notes config demo](docs/assets/config-demo.gif)

## What it does

- Reads note-to-note relations from frontmatter
- Renders each relation label on the matching graph edge
- Supports JavaScript expressions for dynamic labels
- Shows optional detail text when you hover a label
- Adds a command to create a new relation for the current note
- Supports a plugin-level default label color
- Debug panel for development

## Frontmatter format

### String format (original)
```yaml
relations:
  - '("limited-open")[[Open]]("finite-population open model")'
  - '("gossip")[[Communication]]'
```

### Object format (also supported)
```yaml
relations:
  - target: "[[Open]]"
    label: "limited-open"
    detail: "finite-population open model"
```

### Dynamic expressions (new!)

Labels starting with `=` are evaluated as JavaScript using frontmatter properties:

```yaml
relations:
  - '("={{valor}}")[[Target]]("Valor dinâmico")'
  - '("={{valor * 1.1}}")[[Target]]('com 10% de juros')'
  - '("={{a + b}}")[[Target]]('soma de campos')'
```

### Template syntax

You can also use `{{...}}` blocks inside the label:

```yaml
relations:
  - '("=Total: {{valor + taxa}} R$")[[Target]]'
```

## Security note

⚠️ Expressions are evaluated using `new Function()` with access to frontmatter properties. This is by-design and safe because:
1. Your Vault is local — only your notes are evaluated
2. Expressions only read frontmatter, they don't modify anything
3. No network access or file system operations are available

## Dynamic labels behavior

| Scenario | Result |
|----------|--------|
| Label without `=` | Rendered as-is (static) |
| Label with `={{expr}}` | Evaluated using frontmatter |
| Empty result after eval | Label hidden (no text) |
| Syntax error in expression | Shows `⚠️` prefix + original text |
| Frontmatter field missing | Shows `undefined` in label |

## Development

```bash
npm install
npm run build
```

To test in a vault, copy `main.js`, `manifest.json`, and `styles.css` into:
```
<Vault>/.obsidian/plugins/graph-edge-notes-dynamic/
```

Then reload Obsidian and enable **Graph Edge Notes (Dynamic)** under **Settings → Community plugins**.

---

Original plugin by [@li-zane](https://github.com/li-zane) | Fork maintained by Igor Barros
