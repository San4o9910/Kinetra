import type {
  TrainingTemplate,
  TrainingLessonRecipient,
  TrainingAttention,
  TrainingMeasurement,
  TrainingComplaint,
  TrainingSetRecord,
} from '@kinetra/shared';
import type {
  MyTraining,
  TrainingLibrary,
  TrainingPlanInput,
  TrainingStudent,
  TrainingStudentDetail,
} from '@kinetra/shared';
import { trainingRequest } from '../../lib/api';
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
export const trainingApi = {
  lessonRecipients: (id: string) =>
    trainingRequest<{ recipients: TrainingLessonRecipient[] }>(`/lessons/${id}/assignments`),
  assignLesson: (id: string, target: 'all' | 'selected', student_ids: string[]) =>
    trainingRequest<{ assigned: number }>(
      `/lessons/${id}/assignments`,
      json('POST', target === 'all' ? { target } : { target, student_ids }),
    ),
  revokeLesson: (id: string, student: string) =>
    trainingRequest(`/lessons/${id}/assignments/${student}`, json('DELETE')),
  lessonProgress: (id: string, input: { position_seconds?: number; completed?: true }) =>
    trainingRequest(`/lessons/${id}/progress`, json('PUT', input)),
  templates: () => trainingRequest<{ templates: TrainingTemplate[] }>('/templates'),
  saveTemplate: (id: string) => trainingRequest(`/plans/${id}/template`, json('POST')),
  removeTemplate: (id: string) => trainingRequest(`/templates/${id}`, json('DELETE')),
  assignTemplate: (student: string, template_id: string, start_date: string | null) =>
    trainingRequest<{ id: string }>(
      `/students/${student}/template`,
      json('POST', { template_id, start_date }),
    ),
  attention: () => trainingRequest<{ events: TrainingAttention[] }>('/attention'),
  seen: (id: string) => trainingRequest(`/students/${id}/seen`, json('POST')),
  reschedule: (id: string, requested_date: string, reason: string) =>
    trainingRequest(`/workouts/${id}/reschedule`, json('POST', { requested_date, reason })),
  reschedules: () =>
    trainingRequest<{
      requests: {
        id: string;
        workout_id: string;
        status: string;
        requested_date: string;
        reason: string;
      }[];
    }>('/reschedules'),
  reviewReschedule: (id: string, approve: boolean) =>
    trainingRequest(`/reschedules/${id}/review`, json('POST', { approve })),
  measurements: (student?: string) =>
    trainingRequest<{ measurements: TrainingMeasurement[] }>(
      student ? `/students/${student}/measurements` : '/measurements',
    ),
  addMeasurement: (input: Omit<TrainingMeasurement, 'id' | 'photo_id'>) =>
    trainingRequest<{ id: string }>('/measurements', json('POST', input)),
  removeMeasurement: (id: string) => trainingRequest(`/measurements/${id}`, json('DELETE')),
  shareMeasurement: (id: string, share: boolean) =>
    trainingRequest(`/measurements/${id}/sharing`, json('PUT', { share })),
  uploadPhoto: (id: string, file: File) =>
    trainingRequest(`/measurements/${id}/photo`, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type },
    }),
  photoAccess: (id: string) => trainingRequest<{ path: string }>(`/measurements/${id}/photo`),
  complaints: (admin = false) =>
    trainingRequest<{ complaints: TrainingComplaint[] }>(
      admin ? '/admin/complaints' : '/complaints',
    ),
  complain: (reason: string) => trainingRequest('/complaints', json('POST', { reason })),
  reviewComplaint: (
    id: string,
    status: 'reviewing' | 'resolved',
    resolution: string,
    revision: number,
  ) => trainingRequest(`/admin/complaints/${id}`, json('POST', { status, resolution, revision })),
  verificationHistory: (id: string) =>
    trainingRequest<{
      events: {
        from_status: string | null;
        to_status: string;
        reason: string | null;
        created_at: string;
      }[];
    }>(`/admin/verification/${id}/history`),
  uploadStatus: (id: string) =>
    trainingRequest<{
      status: string;
      offset: number;
      size: number;
      original_name: string;
      source_modified: number | null;
      error_message: string;
      chunk_bytes: number;
    }>(`/lessons/${id}/upload`),
  uploadChunk: (id: string, chunk: Blob, offset: number, signal: AbortSignal) =>
    trainingRequest<{ offset: number }>(`/lessons/${id}/chunk`, {
      method: 'PUT',
      body: chunk,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset) },
      signal,
    }),
  finishUpload: (id: string) => trainingRequest(`/lessons/${id}/finish`, json('POST')),
  cancelUpload: (id: string) => trainingRequest(`/lessons/${id}/cancel`, json('POST')),

  students: (signal?: AbortSignal) =>
    trainingRequest<{ students: TrainingStudent[] }>('/students', { signal: signal ?? null }),
  student: (id: string, signal?: AbortSignal) =>
    trainingRequest<TrainingStudentDetail>(`/students/${id}`, { signal: signal ?? null }),
  addStudent: (name: string, contact: string) =>
    trainingRequest<{ id: string; token: string }>('/students', json('POST', { name, contact })),
  invite: (id: string) =>
    trainingRequest<{ token: string }>(`/students/${id}/invite`, json('POST')),
  archive: (id: string) => trainingRequest(`/students/${id}/archive`, json('POST')),
  createPlan: (id: string) =>
    trainingRequest<{ id: string }>(`/students/${id}/plans`, json('POST')),
  savePlan: (id: string, input: TrainingPlanInput) =>
    trainingRequest<{ revision: number }>(`/plans/${id}`, json('PUT', input)),
  publish: (id: string, revision: number) =>
    trainingRequest(`/plans/${id}/publish`, json('POST', { revision })),
  mine: (signal?: AbortSignal) => trainingRequest<MyTraining>('/mine', { signal: signal ?? null }),
  invitation: (token: string) =>
    trainingRequest<{ trainer_name: string }>('/invitation', json('POST', { token })),
  accept: (token: string) => trainingRequest('/invitation/accept', json('POST', { token })),
  log: (
    id: string,
    input: {
      completed?: true;
      base_revision?: number;
      set_records?: TrainingSetRecord[];
      position_seconds?: number;
      difficulty?: number;
      wellbeing?: number;
      note?: string;
    },
  ) =>
    trainingRequest<{ saved: boolean; revision?: number }>(
      `/workouts/${id}/log`,
      json('PUT', input),
    ),
  library: (signal?: AbortSignal) =>
    trainingRequest<TrainingLibrary>('/lessons', { signal: signal ?? null }),
  createLesson: (
    title: string,
    description: string,
    size_bytes: number,
    extra: {
      folder?: string;
      original_name?: string;
      source_modified?: number;
      audience?: 'shared' | 'personal';
      personal_student_id?: string | null;
    } = {},
  ) =>
    trainingRequest<{ id: string }>(
      '/lessons',
      json('POST', { title, description, size_bytes, ...extra }),
    ),
  upload: (id: string, file: File, signal: AbortSignal) =>
    trainingRequest(`/lessons/${id}/file`, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': 'video/mp4' },
      signal,
    }),
  removeLesson: (id: string) => trainingRequest(`/lessons/${id}`, json('DELETE')),
  access: (id: string, signal?: AbortSignal) =>
    trainingRequest<{ path: string }>(`/lessons/${id}/access`, { signal: signal ?? null }),
};
export const trainingMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Не удалось сохранить изменения. Повторите попытку.';
const inviteKey = 'kinetra-training-invite';
export const pendingInvite = (): string => {
  try {
    return sessionStorage.getItem(inviteKey) ?? '';
  } catch {
    return '';
  }
};
export const clearInvite = (): void => {
  try {
    sessionStorage.removeItem(inviteKey);
  } catch {
    /* Storage may be unavailable. */
  }
};
export const captureInvite = (): void => {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('invite');
  if (token && /^[A-Za-z0-9_-]{43}$/u.test(token)) {
    try {
      sessionStorage.setItem(inviteKey, token);
    } catch {
      /* The form also accepts the invitation link. */
    }
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
  }
};
export const inviteLink = (token: string): string =>
  `${window.location.origin}/login#invite=${token}`;
