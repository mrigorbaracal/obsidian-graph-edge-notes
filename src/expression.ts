/**
 * Motor de expressões dinâmicas para labels de arestas.
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
    let value = evaluateExpression(expr, ctx);
    
    // Se for string numérica, converte para número
    if (typeof value === 'string' && value !== '' && !isNaN(Number(value))) {
      value = Number(value);
    }
    
    // Formata números com separador de milhar
    if (typeof value === 'number') {
      value = value.toLocaleString('pt-BR');
    }
    
    result = result.replace(`{{${expr}}}`, String(value));
  }
  
  return result;
}

function evaluateExpression(expr: string, ctx: EvalContext): any {
  try {
    const props = ctx.frontmatter;
    
    // Converte valores string para número quando possível
    const processedProps: Record<string, any> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'string' && !isNaN(Number(value)) && value !== '') {
        processedProps[key] = Number(value);
      } else {
        processedProps[key] = value;
      }
    }
    
    const fn = new Function(
      ...Object.keys(processedProps),
      '"use strict"; return (' + expr + ');'
    );
    return fn(...Object.values(processedProps));
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
