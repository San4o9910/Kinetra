export interface TrainingWorkoutInput {
  id: string;
  title: string;
  instructions: string;
  scheduled_date: string | null;
  duration_minutes: number;
  lesson_id: string | null;
  exercises?: TrainingExercise[];
}
export interface TrainingWorkout extends TrainingWorkoutInput {
  lesson_title: string | null;
  completed_at: string | null;
  position_seconds: number;
  difficulty: number | null;
  wellbeing: number | null;
  note: string;
  set_records?: TrainingSetRecord[];
  progress_revision?: number;
}
export interface TrainingPlanInput {
  title: string;
  goal: string;
  revision: number;
  workouts: TrainingWorkoutInput[];
}
export interface TrainingPlan extends TrainingPlanInput {
  id: string;
  status: 'draft' | 'published' | 'archived';
  workouts: TrainingWorkout[];
}
export interface TrainingStudent {
  id: string;
  name: string;
  contact: string;
  client_id: string | null;
  accepted_at: string | null;
  archived_at: string | null;
  conversation_id: string | null;
  total: number;
  completed: number;
  minutes: number;
  last_completed_at: string | null;
}
export interface AssignedTrainingLesson {
  id: string;
  title: string;
  description: string;
  audience: 'shared' | 'personal';
  duration_seconds: number | null;
  assigned_at: string;
  position_seconds: number;
  completed_at: string | null;
}
export interface TrainingLessonRecipient {
  id: string;
  name: string;
  client_id: string | null;
  position_seconds: number;
  completed_at: string | null;
}
export interface TrainingStudentDetail {
  student: TrainingStudent;
  plans: TrainingPlan[];
  assigned_lessons?: AssignedTrainingLesson[];
}
export interface TrainingLesson {
  audience?: 'shared' | 'personal';
  personal_student_id?: string | null;
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'uploading' | 'processing' | 'ready' | 'failed' | 'archived';
  size_bytes: number;
  duration_seconds: number | null;
  folder?: string;
  original_name?: string;
  source_bytes?: number;
  source_modified?: number | null;
  upload_offset?: number;
  error_message?: string;
  thumbnail_ready?: boolean;
}
export interface TrainingLibrary {
  lessons: TrainingLesson[];
  upload_available: boolean;
  max_bytes: number;
}
export interface MyTraining {
  trainer_name: string | null;
  student_id: string | null;
  plans: TrainingPlan[];
  assigned_lessons?: AssignedTrainingLesson[];
}

export interface TrainingExercise {
  id: string;
  name: string;
  sets: number;
  repetitions: number | null;
  seconds: number | null;
  weight_kg: number | null;
  rest_seconds: number;
  lesson_id: string | null;
}
export interface TrainingSetRecord {
  exercise_id: string;
  set: number;
  repetitions: number | null;
  seconds: number | null;
  weight_kg: number | null;
  completed: boolean;
}
export interface TrainingTemplate {
  id: string;
  title: string;
  goal: string;
  workouts: TrainingWorkoutInput[];
}
export interface TrainingAttention {
  student_id: string;
  name: string;
  kind: 'report' | 'overdue' | 'ending' | 'invitation' | 'reschedule';
  title: string;
  request_id?: string;
  requested_date?: string;
  reason?: string;
}
export interface TrainingMeasurement {
  id: string;
  recorded_date: string;
  weight_kg: number | null;
  waist_cm: number | null;
  chest_cm: number | null;
  hips_cm: number | null;
  note: string;
  share_with_trainer: boolean;
  photo_id: string | null;
}
export interface TrainingComplaint {
  id: string;
  trainer_name: string;
  client_name: string;
  reason: string;
  status: 'new' | 'reviewing' | 'resolved';
  resolution: string;
  revision: number;
  created_at: string;
  events: { status: string; reason: string; created_at: string }[];
}
