import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatPhotoRetryButton } from '../src/features/chat/ChatComposer.js';
import {
  canRetryChatPhotoUpload,
  chatPhotoFailurePresentation,
} from '../src/features/chat/model.js';
import {
  ChatComposerPhotoUploadAttemptGate,
  chatComposerPhotoUploadFailure,
} from '../src/features/chat/photoUploadFailure.js';
import type { ChatPhotoDto } from '../src/features/chat/types.js';
import { ApiClient, ApiRequestError } from '../src/lib/api.js';

const session = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'client@example.test',
    phone: null,
    emailVerified: true,
    createdAt: '2026-08-24T00:00:00.000Z',
  },
  accessToken: 'chat-photo-token',
  tokenType: 'Bearer' as const,
  expiresIn: 900,
};

const failedPhoto = (retryAllowed: boolean): ChatPhotoDto => ({
  id: '93000000-0000-4000-8000-000000000001',
  status: 'failed',
  mime_type: 'image/webp',
  width: 1_200,
  height: 800,
  size_bytes: 120_000,
  expires_at: '2026-08-25T00:00:00.000Z',
  failure_code: 'CHAT_PHOTO_NORMALIZATION_FAILED',
  retry_allowed: retryAllowed,
});

test('T12 failed photo API preserves failure metadata exactly', async () => {
  const exhausted = failedPhoto(false);
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    fetchImpl: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/v1/auth/login') {
        return Response.json(session);
      }
      if (pathname === `/api/v1/chat/photos/${exhausted.id}/status`) {
        return Response.json({ photo: exhausted });
      }
      throw new Error(`Unexpected request ${pathname}`);
    },
  });

  await client.login('client@example.test', 'password');
  assert.deepEqual(await client.getChatPhotoStatus(exhausted.id), { photo: exhausted });
});

test('T12 exhausted photo failure offers no fourth attempt and tells the user to replace it', () => {
  const exhausted = failedPhoto(false);
  const failure = chatPhotoFailurePresentation(exhausted);
  assert.deepEqual(failure, {
    failureCode: 'CHAT_PHOTO_NORMALIZATION_FAILED',
    retryAllowed: false,
    message: 'Повторные попытки обработки исчерпаны. Удалите фотографию и выберите другой файл.',
  });

  const attemptedUploads = [1, 2, 3];
  if (canRetryChatPhotoUpload(exhausted)) {
    attemptedUploads.push(4);
  }
  assert.deepEqual(attemptedUploads, [1, 2, 3]);

  const markup = renderToStaticMarkup(
    createElement(ChatPhotoRetryButton, {
      retryAllowed: failure?.retryAllowed ?? false,
      online: true,
      onRetry: () => attemptedUploads.push(4),
    }),
  );
  assert.equal(markup, '');
});

test('T12 retryable photo failure keeps one same-key retry available', () => {
  const retryable = failedPhoto(true);
  const failure = chatPhotoFailurePresentation(retryable);
  assert.equal(failure?.failureCode, 'CHAT_PHOTO_NORMALIZATION_FAILED');
  assert.equal(failure?.retryAllowed, true);
  assert.match(failure?.message ?? '', /Повторите попытку/u);
  assert.equal(canRetryChatPhotoUpload(retryable), true);

  const idempotencyKeys = ['upload-key-1'];
  if (canRetryChatPhotoUpload(retryable)) {
    idempotencyKeys.push(idempotencyKeys[0] as string);
  }
  assert.deepEqual(idempotencyKeys, ['upload-key-1', 'upload-key-1']);

  const markup = renderToStaticMarkup(
    createElement(ChatPhotoRetryButton, {
      retryAllowed: failure?.retryAllowed ?? false,
      online: true,
      onRetry: () => undefined,
    }),
  );
  assert.match(markup, /data-testid="chat-photo-retry"/u);
  assert.match(markup, />Повторить</u);
});

test('T12 composer treats retry-exhausted 409 as terminal and cannot issue another upload', async () => {
  let uploadPosts = 0;
  let retryState = {
    status: 'failed' as const,
    retryAllowed: true,
    photo: null,
  };
  const attemptGate = new ChatComposerPhotoUploadAttemptGate();
  const idempotencyKey = 'same-upload-key';
  const retryUpload = async (): Promise<void> => {
    if (!attemptGate.beginAttempt(idempotencyKey, retryState)) {
      return;
    }

    uploadPosts += 1;
    try {
      throw new ApiRequestError(
        'Photo retry limit was reached.',
        409,
        'CHAT_PHOTO_RETRY_EXHAUSTED',
        'validation',
      );
    } catch (error) {
      const failure = chatComposerPhotoUploadFailure(error);
      attemptGate.finishAttempt(idempotencyKey, failure);
      retryState = {
        status: 'failed',
        retryAllowed: failure.retryAllowed,
        photo: null,
      };

      const markup = renderToStaticMarkup(
        createElement(ChatPhotoRetryButton, {
          retryAllowed: failure.retryAllowed,
          online: true,
          onRetry: () => undefined,
        }),
      );
      assert.equal(markup, '', 'the exhausted 409 must hide the composer retry action');
      assert.match(failure.message, /Удалите фотографию и выберите другой файл/u);
      assert.equal(failure.failureCode, 'CHAT_PHOTO_RETRY_EXHAUSTED');
    } finally {
      attemptGate.finishAttempt(idempotencyKey);
    }
  };

  await retryUpload();
  await retryUpload();
  assert.equal(uploadPosts, 1, 'a repeated action must not issue a fourth upload POST');
});
