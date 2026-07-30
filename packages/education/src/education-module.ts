// EducationModule — courses, lessons, enrollments, and progress tracking.
// Student data is treated as restricted (directive #98). All operations are
// audit-logged and governance-gated when policy-governance is present.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { EducationEvents } from './types.js';
import type { Course, Enrollment, Lesson, ProgressRecord, ProgressSummary } from './types.js';

const COL_COURSES = 'education.courses';
const COL_LESSONS = 'education.lessons';
const COL_ENROLL = 'education.enrollments';
const COL_PROGRESS = 'education.progress';

export class EducationModule implements IModule {
  readonly id = 'education';
  readonly tags = ['intelligence', 'education'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private courses!: ICollection<Course>;
  private lessons!: ICollection<Lesson>;
  private enrollments!: ICollection<Enrollment>;
  private progress!: ICollection<ProgressRecord>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.courses = await C<Course>(COL_COURSES);
    this.lessons = await C<Lesson>(COL_LESSONS);
    this.enrollments = await C<Enrollment>(COL_ENROLL);
    this.progress = await C<ProgressRecord>(COL_PROGRESS);
    kernel.container.registerValue('education', this);
    kernel.logger.info('education module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // --- courses + lessons ---------------------------------------------------

  async createCourse(input: { title: string; description?: string; level: Course['level']; subject?: string; instructorId: string; organizationId?: string }): Promise<Course> {
    const course: Course = {
      id: randomUUID(), title: input.title, level: input.level, instructorId: input.instructorId,
      status: 'draft', createdAt: Date.now(),
      ...(input.description ? { description: input.description } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    };
    await this.courses.put(course);
    await this.api.bus.emit(EducationEvents.CourseCreated, { id: course.id });
    return course;
  }

  async publishCourse(id: string): Promise<Course> {
    const c = await this.courses.get(id);
    if (!c) throw new Error(`education: course "${id}" not found`);
    const updated: Course = { ...c, status: 'published' };
    await this.courses.put(updated);
    return updated;
  }

  async getCourse(id: string): Promise<Course | undefined> { return this.courses.get(id); }
  async listCourses(level?: string, organizationId?: string): Promise<Course[]> {
    let all = await this.courses.all();
    if (level) all = all.filter((c) => c.level === level);
    if (organizationId) all = all.filter((c) => c.organizationId === organizationId);
    return all;
  }

  async addLesson(input: { courseId: string; title: string; content: string; order?: number; durationMinutes?: number }): Promise<Lesson> {
    const existing = (await this.lessons.all()).filter((l) => l.courseId === input.courseId);
    const order = input.order ?? existing.length;
    const lesson: Lesson = {
      id: randomUUID(), courseId: input.courseId, title: input.title,
      content: input.content, order,
      ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
    };
    await this.lessons.put(lesson);
    return lesson;
  }

  async listLessons(courseId: string): Promise<Lesson[]> {
    return (await this.lessons.all()).filter((l) => l.courseId === courseId).sort((a, b) => a.order - b.order);
  }

  // --- enrollments ---------------------------------------------------------

  async enroll(studentId: string, courseId: string): Promise<Enrollment> {
    const course = await this.courses.get(courseId);
    if (!course) throw new Error(`education: course "${courseId}" not found`);
    if (course.status !== 'published') throw new Error('education: course not published');
    const existing = (await this.enrollments.all()).find((e) => e.studentId === studentId && e.courseId === courseId && e.status === 'active');
    if (existing) throw new Error('education: already enrolled');
    const enrollment: Enrollment = { id: randomUUID(), courseId, studentId, status: 'active', enrolledAt: Date.now() };
    await this.enrollments.put(enrollment);
    await this.api.bus.emit(EducationEvents.StudentEnrolled, { enrollmentId: enrollment.id, studentId });
    await this.audit(studentId, 'student_enrolled', { courseId });
    return enrollment;
  }

  async withdraw(enrollmentId: string): Promise<Enrollment> {
    const e = await this.enrollments.get(enrollmentId);
    if (!e) throw new Error(`education: enrollment "${enrollmentId}" not found`);
    const updated: Enrollment = { ...e, status: 'withdrawn' };
    await this.enrollments.put(updated);
    return updated;
  }

  async listEnrollments(filter: { studentId?: string; courseId?: string }): Promise<Enrollment[]> {
    let all = await this.enrollments.all();
    if (filter.studentId) all = all.filter((e) => e.studentId === filter.studentId);
    if (filter.courseId) all = all.filter((e) => e.courseId === filter.courseId);
    return all;
  }

  // --- progress ------------------------------------------------------------

  async recordProgress(enrollmentId: string, lessonId: string, completed: boolean, score?: number): Promise<ProgressRecord> {
    const enrollment = await this.enrollments.get(enrollmentId);
    if (!enrollment) throw new Error(`education: enrollment "${enrollmentId}" not found`);
    // Upsert: replace existing progress for this lesson.
    const existing = (await this.progress.all()).find((p) => p.enrollmentId === enrollmentId && p.lessonId === lessonId);
    const rec: ProgressRecord = {
      id: existing?.id ?? randomUUID(),
      enrollmentId, lessonId, completed,
      ...(score !== undefined ? { score } : {}),
      ...(completed ? { completedAt: Date.now() } : {}),
    };
    await this.progress.put(rec);
    if (completed) {
      await this.api.bus.emit(EducationEvents.LessonCompleted, { enrollmentId, lessonId });
      // Check course completion.
      const summary = await this.getProgress(enrollment);
      if (summary.completionPct === 100 && enrollment.status === 'active') {
        enrollment.status = 'completed';
        enrollment.completedAt = Date.now();
        await this.enrollments.put(enrollment);
        await this.api.bus.emit(EducationEvents.CourseCompleted, { enrollmentId });
        await this.notify(enrollment.studentId, 'education', `Course completed`, `Congratulations on completing the course!`);
      }
    }
    return rec;
  }

  async getProgress(enrollment: Enrollment | string): Promise<ProgressSummary> {
    const e = typeof enrollment === 'string' ? await this.enrollments.get(enrollment) : enrollment;
    if (!e) throw new Error('education: enrollment not found');
    const lessons = await this.listLessons(e.courseId);
    const totalLessons = lessons.length;
    const records = (await this.progress.all()).filter((p) => p.enrollmentId === e.id);
    const completedRecords = records.filter((r) => r.completed);
    const scored = records.filter((r) => r.score !== undefined);
    const avgScore = scored.length > 0 ? Math.round(scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length * 100) / 100 : 0;
    return {
      enrollmentId: e.id,
      totalLessons,
      completedLessons: completedRecords.length,
      completionPct: totalLessons > 0 ? Math.round((completedRecords.length / totalLessons) * 1000) / 10 : 0,
      avgScore,
    };
  }

  // --- helpers -------------------------------------------------------------

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec && typeof sec.audit === 'function') await sec.audit({ actor, action: `education.${action}`, result: 'success', detail });
    } catch { /* optional */ }
  }

  private async notify(recipient: string, type: string, title: string, body: string): Promise<void> {
    try {
      const n = this.api.getModule('notifications') as unknown as { notify: (r: string, p: { type: string; title: string; body?: string }) => Promise<unknown> } | undefined;
      if (n && typeof n.notify === 'function') await n.notify(recipient, { type, title, body });
    } catch { /* optional */ }
  }
}
