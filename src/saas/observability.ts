export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogContext {
  requestId?: string;
  orgId?: string;
  userId?: string;
  jobId?: string;
  [key: string]: any;
}

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  durationMs?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export class StructuredLogger {
  private baseContext: LogContext;
  private logSink: (entry: StructuredLogEntry) => void;

  constructor(baseContext: LogContext = {}, sink?: (entry: StructuredLogEntry) => void) {
    this.baseContext = baseContext;
    this.logSink = sink || ((entry) => {
      // In production, outputs to stdout JSON stream for Datadog/CloudWatch/Kibana
      const line = JSON.stringify(entry);
      if (entry.level === "ERROR") {
        process.stderr.write(line + "\n");
      } else {
        process.stdout.write(line + "\n");
      }
    });
  }

  public child(extraContext: LogContext): StructuredLogger {
    return new StructuredLogger({ ...this.baseContext, ...extraContext }, this.logSink);
  }

  public log(level: LogLevel, message: string, context: LogContext = {}, durationMs?: number, err?: Error): void {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...this.baseContext, ...context },
      durationMs,
      error: err ? { name: err.name, message: err.message, stack: err.stack } : undefined
    };
    this.logSink(entry);
  }

  public info(message: string, context: LogContext = {}, durationMs?: number): void {
    this.log("INFO", message, context, durationMs);
  }

  public warn(message: string, context: LogContext = {}, err?: Error): void {
    this.log("WARN", message, context, undefined, err);
  }

  public error(message: string, err?: Error, context: LogContext = {}): void {
    this.log("ERROR", message, context, undefined, err);
  }

  public debug(message: string, context: LogContext = {}): void {
    this.log("DEBUG", message, context);
  }
}

export interface SaasMetricsSnapshot {
  httpRequestsTotal: number;
  httpRequestsByStatus: Record<number, number>;
  jobsTotal: number;
  jobsCompleted: number;
  jobsFailed: number;
  tokensPromptTotal: number;
  tokensCompletionTotal: number;
  totalCostCents: number;
  activeQueueDepth: number;
}

export class MetricsCollector {
  private requestsTotal = 0;
  private requestsByStatus = new Map<number, number>();
  private jobsTotal = 0;
  private jobsCompleted = 0;
  private jobsFailed = 0;
  private tokensPrompt = 0;
  private tokensCompletion = 0;
  private costCents = 0;
  private queueDepth = 0;

  public recordHttpRequest(statusCode: number): void {
    this.requestsTotal += 1;
    const current = this.requestsByStatus.get(statusCode) || 0;
    this.requestsByStatus.set(statusCode, current + 1);
  }

  public recordJobSubmitted(): void {
    this.jobsTotal += 1;
  }

  public recordJobCompleted(promptTokens = 0, completionTokens = 0, costCents = 0): void {
    this.jobsCompleted += 1;
    this.tokensPrompt += promptTokens;
    this.tokensCompletion += completionTokens;
    this.costCents += costCents;
  }

  public recordJobFailed(): void {
    this.jobsFailed += 1;
  }

  public updateQueueDepth(depth: number): void {
    this.queueDepth = depth;
  }

  public getSnapshot(): SaasMetricsSnapshot {
    const statusMap: Record<number, number> = {};
    for (const [code, count] of this.requestsByStatus.entries()) {
      statusMap[code] = count;
    }

    return {
      httpRequestsTotal: this.requestsTotal,
      httpRequestsByStatus: statusMap,
      jobsTotal: this.jobsTotal,
      jobsCompleted: this.jobsCompleted,
      jobsFailed: this.jobsFailed,
      tokensPromptTotal: this.tokensPrompt,
      tokensCompletionTotal: this.tokensCompletion,
      totalCostCents: Number(this.costCents.toFixed(4)),
      activeQueueDepth: this.queueDepth
    };
  }
}
