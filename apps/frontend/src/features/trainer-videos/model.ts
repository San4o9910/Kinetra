import type { TrainerVideoProgramResponse, TrainerVideoSlotDto } from '@kinetra/shared';

export const videoFailureText = (code: string | null): string => {
  const messages: Record<string, string> = {
    invalid_mp4_container: 'Файл не является корректным MP4.',
    unsupported_video_codec: 'Нужно видео H.264/AVC.',
    unsupported_audio_codec: 'Поддерживается только звук AAC.',
    invalid_duration: 'Длительность должна быть от 10 секунд до 3 часов.',
    invalid_resolution: 'Разрешение видео превышает 3840×2160.',
    invalid_frame_rate: 'Частота кадров должна быть не выше 60 fps.',
    ffprobe_failed: 'Не удалось проверить структуру видео.',
    verification_retry_exhausted:
      'Проверка временно остановлена. Можно отменить файл или загрузить новую версию.',
  };
  return code === null
    ? 'Видео не прошло проверку.'
    : (messages[code] ?? 'Видео не прошло безопасную проверку.');
};

export const videoStatusText = (slot: TrainerVideoSlotDto): string => {
  switch (slot.slot_state) {
    case 'empty':
      return 'Видео не загружено';
    case 'uploading':
      return 'Загрузка продолжается';
    case 'processing':
      return 'Файл загружен, проверяем';
    case 'available':
      return 'Доступно клиентам';
    case 'replacing':
      return 'Старое видео доступно, новое загружается';
    case 'failed':
      return videoFailureText(slot.latest_upload?.failure_code ?? null);
    case 'hidden':
      return 'Скрыто — клиенты видят заглушку';
  }
};

export const validateTrainerVideoProgram = (
  program: TrainerVideoProgramResponse,
): TrainerVideoProgramResponse => {
  if (
    program.summary.total !== 84 ||
    program.weeks.length !== 12 ||
    program.weeks.some(
      (week, weekIndex) =>
        week.week_number !== weekIndex + 1 ||
        week.days.length !== 7 ||
        week.days.some((day, dayIndex) => day.day_of_week !== dayIndex + 1),
    )
  ) {
    throw new Error('Сервер вернул неполную программу видео. Попробуйте ещё раз.');
  }

  const videoIds = program.weeks.flatMap((week) => week.days.map((day) => day.video_id));
  if (new Set(videoIds).size !== 84) {
    throw new Error('Сервер вернул неполную программу видео. Попробуйте ещё раз.');
  }

  return program;
};
