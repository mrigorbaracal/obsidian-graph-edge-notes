# Fork Notes — Dynamic Labels

## Mapeamento de Funções

### `src/graphOverlay.ts`
| Função/Local | Mudança Pretendida |
|---|---|
| `createLabel()` (linha ~232) | Interceptar `relation.label` antes de `setText()`. Se começar com `=`, usar `evaluateLabel()` para computar texto dinâmico. |
| `applyLabelAppearance()` (linha ~667) | Manter estilos, mas permitir atualização de texto sem reconstruir o label. |
| `rebuildLabels()` (linha ~191) | Após reconstruir, aplicar expressões dinâmicas nos labels que começam com `=`. |

### `src/main.ts`
| Função/Local | Mudança Pretendida |
|---|---|
| `registerEvents()` (linha ~153) | Adicionar listener para `metadataCache.on("changed")` com debounce (300ms). Após debounce, chamar `overlay.updateDynamicLabels(file)` em vez de rebuild completo. |

### `src/relationStore.ts`
| Função/Local | Mudança Pretendida |
|---|---|
| `getRelationsForConnection()` | Retornar também o frontmatter da nota de origem para uso no contexto de expressão. |

### `src/types.ts`
| Campo | Mudança |
|---|---|
| `ResolvedRelation` | Adicionar `sourceFrontmatter?: Record<string, any>` para permitir acesso às propriedades da nota de origem. |

---

## Estratégia de A PIXI/HTML

O plugin original **não usa PIXI.Text** — ele usa **HTMLDivElement** (`labelEl`) posicionado via CSS sobre o canvas PIXI. Isso significa:

1. **Para atualizar texto dinâmico**, basta chamar `labelEl.setText(newText)` — sem recriar o objeto.
2. **Para lidar com erros**, aplicamos prefixo `⚠️` e mantemos o label visível com opacidade reduzida.
3. **Para strings vazias**, usamos `labelEl.style.display = "none"` ou `labelEl.toggleClass("is-hidden", true)`.

---

## Formato da Expressão

```yaml
relations:
  - '("={{valor + 100}}")[[Target]]("detail")'
  - '("={{frontmatter.valor + frontmatter.taxa}}")[[Target]]'
```

- Se `label` começa com `=`, é expressão dinâmica
- Blocos `{{...}}` são avaliados com `new Function()`
- `props` no contexto = `frontmatter` da nota de origem
