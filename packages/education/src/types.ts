// JATA Qi Education — types (#23). Student data is SENSITIVE (directive #98:
// protect children and student data through strict privacy controls).

export type CourseLevel = 'primary' | 'secondary' | 'tertiary' | 'professional' | 'lifelong';
export type CourseStatus = 'draft' | 'published' | 'archived';
export type EnrollmentStatus = 'active' | 'completed' | 'withdrawn';

export interface Course {
  id: string;
  title: string;
  description?: string;
  level: CourseLevel;
  subject?: string;
  instructorId: string;
  organizationId?: string;
  status: CourseStatus;
  createdAt: number;
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  content: string;
  order: number;
  durationMinutes?: number;
}

export interface Enrollment {
  id: string;
  courseId: string;
  studentId: string;
  status: EnrollmentStatus;
  enrolledAt: number;
  completedAt?: number;
}

export interface ProgressRecord {
  id: string;
  enrollmentId: string;
  lessonId: string;
  completed: boolean;
  score?: number;
  completedAt?: number;
}

export interface ProgressSummary {
  enrollmentId: string;
  totalLessons: number;
  completedLessons: number;
  completionPct: number;
  avgScore: number;
}

export const EducationEvents = Object.freeze({
  CourseCreated: 'education.course.created',
  StudentEnrolled: 'education.student.enrolled',
  LessonCompleted: 'education.lesson.completed',
  CourseCompleted: 'education.course.completed',
} as const);
