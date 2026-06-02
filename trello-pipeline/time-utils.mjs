export const MOUNTAIN_OFFSET      = -6;
export const WORK_START_HOUR      = 7;
export const WORK_END_HOUR        = 16;
export const LUNCH_START_HOUR     = 12;
export const LUNCH_END_HOUR       = 13;
export const EVENING_CUTOFF_HOUR  = 20;
export const MORNING_START_HOUR   = 8;
export const MIN_TASK_GAP_MINUTES = 60;

export function evTime(event, field) {
  return new Date(event[field]?.dateTime || event[field]?.date || 0).getTime();
}
