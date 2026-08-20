declare global {
  namespace Express {
    interface Request {
      auth?: {
        readonly userId: string;
        readonly sessionId: string;
      };
    }
  }
}

export {};
