import type { Diagnostic } from '../../packages/sdk/src';

export type DiagnosticProblemSeverity = Diagnostic['severity'];

export type DiagnosticProblem = {
  id: string;
  severity: DiagnosticProblemSeverity;
  source: string;
  code?: string;
  file: string;
  line: number;
  msg: string;
};

export function diagnosticProblemSeverity(severity: Diagnostic['severity']): DiagnosticProblemSeverity {
  return severity;
}

export function diagnosticToProblem(diagnostic: Diagnostic): DiagnosticProblem {
  return {
    id: diagnostic.id,
    severity: diagnosticProblemSeverity(diagnostic.severity),
    source: diagnostic.source,
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
    file: diagnostic.file,
    line: diagnostic.range.start.line + 1,
    msg: diagnostic.message,
  };
}

export function diagnosticsToProblems(diagnostics: Diagnostic[]): DiagnosticProblem[] {
  return diagnostics.map(diagnosticToProblem);
}
