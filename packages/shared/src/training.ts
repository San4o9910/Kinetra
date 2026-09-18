export interface TrainingWorkoutInput {
  id: string;
  title: string;
  instructions: string;
  scheduled_date: string | null;
  duration_minutes: number;
  lesson_id: string | null;
}
export interface TrainingWorkout extends TrainingWorkoutInput {
  lesson_title: string | null;
  completed_at: string | null;
  position_seconds: number;
  difficulty: number | null;
  wellbeing: number | null;
  note: string;
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
export interface TrainingStudentDetail {
  student: TrainingStudent;
  plans: TrainingPlan[];
}
export interface TrainingLesson {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'uploading' | 'ready' | 'failed' | 'archived';
  size_bytes: number;
  duration_seconds: number | null;
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
}
