/**
 * Motor de expressões dinâmicas para labels de arestas.
 * Suporta SUM(), COUNT(), AVG(), MIN(), MAX() para agregar inline fields.
 */

export interface EvalContext {
  frontmatter: Record<string, any>;
}

export interface EvalResult {
  text: string;
  isDynamic: boolean;
  error?: string;
}

/**
 * Extrai todos os valores de campos que seguem o padrão `prefixo_N_chave`
 * Ex: transacao_1_valor, transacao_2_valor -> [5000, 3500]
 */
function extractNumberedFields(frontmatter: Record<string, any>, pattern: string): number[] {
  const regex = new RegExp(`^${pattern}_(\\d+)_(.+)$`);
  const values: number[] = [];
  
  for (const [key, value] of Object.entries(frontmatter)) {
    const match = key.match(regex);
    if (match) {
      const num = parseFloat(String(value).replace('.', '').replace(',', '.'));
      if (!isNaN(num)) {
        values.push(num);
      }
    }
  }
  
  return values;
}

/**
 * SUM(pattern) - soma todos os campos numerados que seguem o padrão
 * Ex: SUM(transacao) -> soma transacao_1_valor + transacao_2_valor + ...
 * Ou: SUM(transacao_valor) -> soma todos os campos transacao_N_valor
 */
function evaluateSUM(args: string, ctx: EvalContext): number {
  const pattern = args.trim();
  const values = extractNumberedFields(ctx.frontmatter, pattern);
  return values.reduce((a, b) => a + b, 0);
}

/**
 * COUNT(pattern) - conta quantos campos existem
 */
function evaluateCOUNT(args: string, ctx: EvalContext): number {
  const pattern = args.trim();
  const values = extractNumberedFields(ctx.frontmatter, pattern);
  return values.length;
}

/**
 * AVG(pattern) - média dos valores
 */
function evaluateAVG(args: string, ctx: EvalContext): number {
  const pattern = args.trim();
  const values = extractNumberedFields(ctx.frontmatter, pattern);
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Avalia uma expressão que pode conter funções de agregação
 */
function evaluateExpression(expr: string, ctx: EvalContext): any {
  try {
    let processedExpr = expr;
    
    // Substitui SUM(pattern) pelo valor calculado
    processedExpr = processedExpr.replace(
      /SUM\(([^)]+)\)/g,
      (_, args) => String(evaluateSUM(args, ctx))
    );
    
    // Substitui COUNT(pattern)
    processedExpr = processedExpr.replace(
      /COUNT\(([^)]+)\)/g,
      (_, args) => String(evaluateCOUNT(args, ctx))
    );
    
    // Substitui AVG(pattern)
    processedExpr = processedExpr.replace(
      /AVG\(([^)]+)\)/g,
      (_, args) => String(evaluateAVG(args, ctx))
    );
    
    // Prepara props para a função
    const props = ctx.frontmatter;
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
      '"use strict"; return (' + processedExpr + ');'
    );
    return fn(...Object.values(processedProps));
  } catch (e) {
    console.warn(`[Graph Edge Notes] Erro ao avaliar expressão: ${expr}`, e);
    return undefined;
  }
}

function evaluateTemplate(raw: string, ctx: EvalContext): string {
  const regex = /\{\{([^}]+)\}\}/g;
  let result = raw;
  let match: RegExpExecArray | null;
  
  while ((match = regex.exec(raw)) !== null) {
    const expr = match[1]?.trim() ?? '';
    let value = evaluateExpression(expr, ctx);
    
    if (typeof value === 'string' && value !== '' && !isNaN(Number(value))) {
      value = Number(value);
    }
    
    if (typeof value === 'number') {
      value = value.toLocaleString('pt-BR');
    }
    
    result = result.replace(`{{${expr}}}`, String(value));
  }
  
  return result;
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
