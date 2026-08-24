import type { RequestHandler } from 'express';

import { createAuthMiddleware, type AccessTokenVerifier } from '../auth/middleware.js';
import { SystemClock, type Clock } from '../auth/service.js';
import { HmacJwtAccessTokenService } from '../auth/tokens.js';
import { env } from '../config/env.js';
import { databasePool } from '../db/pool.js';
import { ChatMediaCleanupService } from './cleanup-service.js';
import { ChatEventHub } from './event-hub.js';
import {
  ImageMagickChatImageProcessor,
  UnavailableChatMediaStore,
  type ChatImageProcessor,
  type ChatMediaStore,
} from './media.js';
import { PostgresChatRepository } from './postgres-chat.repository.js';
import { InMemoryChatRateLimiter, type ChatRateLimiter } from './rate-limit.js';
import type { ChatRepository } from './repository.js';
import { S3ChatMediaStore } from './s3-chat-media.store.js';
import { ChatService } from './service.js';

export interface ChatRuntime {
  readonly service: ChatService;
  readonly authMiddleware: RequestHandler;
  readonly eventHub: ChatEventHub;
  readonly rateLimiter: ChatRateLimiter;
  readonly cleanupService: ChatMediaCleanupService;
  readonly trustedProxyHops: number;
}

export interface CreateChatRuntimeOptions {
  readonly accessTokenVerifier?: AccessTokenVerifier;
  readonly repository?: ChatRepository;
  readonly eventHub?: ChatEventHub;
  readonly rateLimiter?: ChatRateLimiter;
  readonly imageProcessor?: ChatImageProcessor;
  readonly mediaStore?: ChatMediaStore;
  readonly clock?: Clock;
  readonly trustedProxyHops?: number;
}

const productionMediaStore = (): ChatMediaStore =>
  env.s3 === null
    ? new UnavailableChatMediaStore()
    : new S3ChatMediaStore({
        endpoint: env.s3.endpoint,
        region: env.s3.region,
        bucket: env.s3.bucket,
        accessKeyId: env.s3.accessKeyId,
        secretAccessKey: env.s3.secretAccessKey,
        forcePathStyle: env.s3.forcePathStyle,
      });

export const createProductionChatRuntime = (
  options: CreateChatRuntimeOptions = {},
): ChatRuntime => {
  const verifier =
    options.accessTokenVerifier ??
    new HmacJwtAccessTokenService(
      env.auth.jwtAccessSecret,
      env.auth.jwtIssuer,
      env.auth.jwtAudience,
      env.auth.jwtAccessTtlSeconds,
    );
  const repository = options.repository ?? new PostgresChatRepository(databasePool);
  const eventHub = options.eventHub ?? new ChatEventHub();
  const rateLimiter = options.rateLimiter ?? new InMemoryChatRateLimiter();
  const imageProcessor = options.imageProcessor ?? new ImageMagickChatImageProcessor();
  const mediaStore = options.mediaStore ?? productionMediaStore();
  const clock = options.clock ?? new SystemClock();

  if (env.chat.photoUploadsEnabled && !mediaStore.available) {
    throw new Error('CHAT_PHOTO_UPLOADS_ENABLED=true requires complete private S3 configuration.');
  }

  const service = new ChatService({
    repository,
    eventPublisher: eventHub,
    rateLimiter,
    imageProcessor,
    mediaStore,
    clock,
    enabled: env.chat.enabled,
    photoUploadsEnabled: env.chat.photoUploadsEnabled,
    mediaUrlTtlSeconds: env.chat.mediaUrlTtlSeconds,
    cursorSecret: env.auth.jwtAccessSecret,
  });

  return {
    service,
    authMiddleware: createAuthMiddleware(verifier),
    eventHub,
    rateLimiter,
    cleanupService: new ChatMediaCleanupService(repository, mediaStore, clock),
    trustedProxyHops: options.trustedProxyHops ?? env.trustProxyHops,
  };
};
