/**
 * Motor de expressões dinâmicas para labels de arestas.
 * Permite usar JavaScript no campo label das relações.
 */

export interface EvalContext {
  frontmatter: Record<string, any>;
}

export interface EvalResult {
  text: string;
  isDynamic: boolean;
  error?: string;
}

function evaluateTemplate(raw: string, ctx: EvalContext): string {
  const regex = /\{\{([^}]+)\}\}/g;
  let result = raw;
  let match: RegExpExecArray | null;
  
  while ((match = regex.exec(raw)) !== null) {
    const expr = match[1]?.trim() ?? '';
    const value = evaluateExpression(expr, ctx);
    result = result.replace(`{{${expr}}}`, String(value));
  }
  
  return result;
}

function evaluateExpression(expr: string, ctx: EvalContext): any {
  try {
    const fn = new Function('props', '"use strict"; return (' + expr + ');');
    return fn(ctx.frontmatter);
  } catch (e) {
    console.warn(`[Graph Edge Notes] Erro ao avaliar expressão: ${expr}`, e);
    return undefined;
  }
}

export function evaluateLabel(raw: string, ctx: EvalContext): EvalResult {
  if (!raw || !raw.startsWith('=')) {
    return { text: raw, isDynamic: false };
  }
  
  const expr = raw.slice(1).trim();
  
  if (!expr) {
    return { text: raw, isDynamic: true, error: 'Expressão vazia' };
  }
  
  try {
    let text: string;
    
    if (expr.includes('{{')) {
      text = evaluateTemplate(expr, ctx);
    } else {
      const value = evaluateExpression(expr, ctx);
      text = value === undefined || value === null ? '' : String(value);
    }
    
    return { text, isDynamic: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { text: raw, isDynamic: true, error };
  }
}
