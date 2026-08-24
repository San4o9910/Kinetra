import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { HttpError } from '../auth/errors.js';
import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import { resolveChatClientIp } from './client-ip.js';
import { acquireChatMultipartSlot, ChatMediaError, readSinglePhotoMultipart } from './media.js';
import {
  conversationListQuerySchema,
  emptyObjectSchema,
  messageListQuerySchema,
  parseStrictly,
  readUpdateSchema,
  sendMessageSchema,
  uuidSchema,
} from './schema.js';
import type { ChatRequestContext, ChatService } from './service.js';

export interface ChatRouterDependencies {
  readonly service: ChatService;
  readonly authMiddleware: RequestHandler;
  readonly trustedProxyHops?: number;
}

const disablePrivateCaching = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};

const requestContext = (request: Request, trustedProxyHops: number): ChatRequestContext => {
  const principal = requireAuthenticatedPrincipal(request);
  return {
    userId: principal.userId,
    sessionId: principal.sessionId,
    ip: resolveChatClientIp(
      {
        remoteAddress: request.socket.remoteAddress,
        xForwardedFor: request.headers['x-forwarded-for'],
      },
      trustedProxyHops,
    ),
  };
};

const conversationIdFrom = (request: Request): string =>
  parseStrictly(uuidSchema, request.params.conversationId);

const photoIdFrom = (request: Request): string => parseStrictly(uuidSchema, request.params.photoId);

const forwardChatError = (error: unknown, next: NextFunction): void => {
  if (error instanceof ChatMediaError) {
    next(new HttpError(error.statusCode, error.code, error.message));
    return;
  }

  next(error);
};

export const createChatRouter = ({
  service,
  authMiddleware,
  trustedProxyHops = 0,
}: ChatRouterDependencies): Router => {
  const router = Router();
  router.use(disablePrivateCaching);
  router.use(authMiddleware);

  router.get('/session', (request, response, next): void => {
    void service
      .getSession(requestContext(request, trustedProxyHops))
      .then((session) => response.status(200).json(session))
      .catch(next);
  });

  router.post('/conversations', (request, response, next): void => {
    try {
      parseStrictly(emptyObjectSchema, request.body ?? {});
    } catch (error) {
      next(error);
      return;
    }

    void service
      .createConversation(requestContext(request, trustedProxyHops))
      .then((result) =>
        response.status(result.created ? 201 : 200).json({ conversation: result.conversation }),
      )
      .catch(next);
  });

  router.get('/conversations', (request, response, next): void => {
    let query;

    try {
      query = parseStrictly(conversationListQuerySchema, request.query);
    } catch (error) {
      next(error);
      return;
    }

    void service
      .listConversations(requestContext(request, trustedProxyHops), query)
      .then((page) => response.status(200).json(page))
      .catch(next);
  });

  router.get('/conversations/:conversationId', (request, response, next): void => {
    let conversationId: string;

    try {
      conversationId = conversationIdFrom(request);
      parseStrictly(emptyObjectSchema, request.query);
    } catch (error) {
      next(error);
      return;
    }

    void service
      .getConversationSummary(requestContext(request, trustedProxyHops), conversationId)
      .then((conversation) => response.status(200).json({ conversation }))
      .catch(next);
  });

  router.get('/conversations/:conversationId/messages', (request, response, next): void => {
    let conversationId: string;
    let query;

    try {
      conversationId = conversationIdFrom(request);
      query = parseStrictly(messageListQuerySchema, request.query);
    } catch (error) {
      next(error);
      return;
    }

    void service
      .listMessages(requestContext(request, trustedProxyHops), conversationId, query)
      .then((page) => response.status(200).json(page))
      .catch(next);
  });

  router.post('/conversations/:conversationId/messages', (request, response, next): void => {
    let conversationId: string;
    let body;

    try {
      conversationId = conversationIdFrom(request);
      body = parseStrictly(sendMessageSchema, request.body);
    } catch (error) {
      next(error);
      return;
    }

    void service
      .sendMessage(requestContext(request, trustedProxyHops), conversationId, body)
      .then((result) =>
        response.status(result.created ? 201 : 200).json({
          message: result.message,
          conversation_state: result.conversationState,
          replayed: !result.created,
        }),
      )
      .catch(next);
  });

  router.put('/conversations/:conversationId/read', (request, response, next): void => {
    let conversationId: string;
    let body;

    try {
      conversationId = conversationIdFrom(request);
      body = parseStrictly(readUpdateSchema, request.body);
    } catch (error) {
      next(error);
      return;
    }

    void service
      .markRead(requestContext(request, trustedProxyHops), conversationId, body.through_sequence)
      .then((conversationState) =>
        response.status(200).json({ conversation_state: conversationState }),
      )
      .catch(next);
  });

  router.post('/conversations/:conversationId/photos', (request, response, next): void => {
    let conversationId: string;
    let clientUploadId: string;
    let context: ChatRequestContext;
    let releaseMultipartSlot: (() => void) | null = null;

    try {
      conversationId = conversationIdFrom(request);
      clientUploadId = parseStrictly(uuidSchema, request.get('idempotency-key'));
      context = requestContext(request, trustedProxyHops);
      releaseMultipartSlot = acquireChatMultipartSlot();
    } catch (error) {
      forwardChatError(error, next);
      return;
    }

    void (async () => {
      const admission = await service.preflightPhotoUpload(context);
      const upload = await readSinglePhotoMultipart(request, (bytes) =>
        service.accountPhotoUploadBytes(admission, bytes),
      );
      return service.uploadPhotoAfterPreflight(
        context,
        conversationId,
        clientUploadId,
        upload.bytes,
        admission,
      );
    })()
      .then((result) => {
        if (result.statusCode === 202) {
          response.setHeader('Retry-After', '2');
        }

        response.status(result.statusCode).json({ photo: result.photo });
      })
      .catch((error: unknown) => forwardChatError(error, next))
      .finally(() => releaseMultipartSlot?.());
  });

  router.get('/photos/:photoId/status', (request, response, next): void => {
    let photoId: string;

    try {
      photoId = photoIdFrom(request);
    } catch (error) {
      next(error);
      return;
    }

    void service
      .getPhotoStatus(requestContext(request, trustedProxyHops), photoId)
      .then((photo) => {
        if (photo.status === 'processing') {
          response.setHeader('Retry-After', '2');
        }

        response.status(200).json({ photo });
      })
      .catch(next);
  });

  router.get('/photos/:photoId/access', (request, response, next): void => {
    let photoId: string;

    try {
      photoId = photoIdFrom(request);
    } catch (error) {
      next(error);
      return;
    }

    void service
      .getPhotoAccess(requestContext(request, trustedProxyHops), photoId)
      .then((access) => response.status(200).json(access))
      .catch(next);
  });

  return router;
};
