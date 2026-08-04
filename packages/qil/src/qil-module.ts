// QiL kernel module — exposes the QiL language (parse/validate/compile) as a
// kernel service and publishes compile events on the bus.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { compileSource } from './lowerer.js';
import { format } from './formatter.js';
import { lint } from './linter.js';
import { parse } from './parser.js';
import { validate } from './validator.js';
import { QiLEvents } from './types.js';
import type { Diagnostic, ExecutionPlan, QiLCompileResult, QiLProgram } from './types.js';

export class QiLModule implements IModule {
  readonly id = 'qil';
  readonly tags = ['core', 'language'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('qil', this);
    kernel.logger.info('QiL language module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> {
    /* no background work */
  }

  async stop(_kernel: KernelApi): Promise<void> {
    /* stateless */
  }

  /** Parse QiL source into an AST (throws on syntax errors). */
  parse(source: string): QiLProgram {
    return parse(source);
  }

  /** Validate a parsed program; returns diagnostics. */
  validate(program: QiLProgram) {
    return validate(program);
  }

  /**
   * Format QiL source into canonical style (2-space indent, one statement per
   * line). Idempotent: format(format(src)) === format(src).
   */
  format(source: string): string {
    return format(source);
  }

  /**
   * Lint QiL source: validator diagnostics + semantic warnings (duplicate
   * declarations, unused agents, dangling `after:` references, unreachable
   * steps, empty missions). Never throws; returns [] on syntax errors (the
   * parser's own diagnostics surface through compile()).
   */
  lint(source: string): Diagnostic[] {
    return lint(this.parse(source));
  }

  /**
   * Compile QiL source into an execution plan. Emits lifecycle events and
   * records diagnostics. Throws only on unrecoverable syntax errors; semantic
   * errors are surfaced in `result.diagnostics` with `ok === false`.
   */
  async compile(source: string): Promise<QiLCompileResult> {
    const result = compileSource(source);
    if (result.ok && result.plan) {
      await this.api.bus.emit(QiLEvents.PlanCompiled, { planId: result.plan.id, steps: result.plan.steps.length });
    } else {
      await this.api.bus.emit(QiLEvents.CompileError, { diagnostics: result.diagnostics });
    }
    return result;
  }

  /** Compile and assert success — convenience for callers that validated input. */
  async plan(source: string): Promise<ExecutionPlan> {
    const result = await this.compile(source);
    if (!result.ok || !result.plan) {
      const first = result.diagnostics.find((d) => d.severity === 'error');
      throw new Error(first?.message ?? 'QiL compilation failed');
    }
    return result.plan;
  }
}
