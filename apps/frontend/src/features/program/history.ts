const workoutHistoryKeys = ['kinetraWorkoutVideoId', 'kinetraProgramWeek'] as const;

const isHistoryRecord = (state: unknown): state is Record<string, unknown> =>
  typeof state === 'object' && state !== null && !Array.isArray(state);

export const withoutWorkoutHistorySentinel = (state: unknown): unknown => {
  if (!isHistoryRecord(state)) {
    return state;
  }

  if (!workoutHistoryKeys.some((key) => Object.prototype.hasOwnProperty.call(state, key))) {
    return state;
  }

  const nextState: Record<string, unknown> = { ...state };

  for (const key of workoutHistoryKeys) {
    delete nextState[key];
  }

  return Object.keys(nextState).length === 0 ? null : nextState;
};

export const clearWorkoutHistorySentinel = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const currentState: unknown = window.history.state;
  const nextState = withoutWorkoutHistorySentinel(currentState);

  if (nextState === currentState) {
    return false;
  }

  window.history.replaceState(nextState, '', window.location.href);
  return true;
};
