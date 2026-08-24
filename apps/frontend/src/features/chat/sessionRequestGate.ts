export interface ChatSessionRequestTicket {
  readonly controller: AbortController;
  readonly version: number;
}

export class ChatSessionRequestGate {
  private controller: AbortController | null = null;
  private version = 0;

  begin(): ChatSessionRequestTicket {
    this.controller?.abort();
    const controller = new AbortController();
    const version = ++this.version;
    this.controller = controller;
    return { controller, version };
  }

  invalidate(): void {
    this.controller?.abort();
    this.controller = null;
    this.version += 1;
  }

  isCurrent(ticket: ChatSessionRequestTicket): boolean {
    return (
      !ticket.controller.signal.aborted &&
      this.controller === ticket.controller &&
      this.version === ticket.version
    );
  }

  finish(ticket: ChatSessionRequestTicket): void {
    if (this.controller === ticket.controller) {
      this.controller = null;
    }
  }
}
