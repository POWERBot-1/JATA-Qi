import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { EducationModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('EducationModule', () => {
  let kernel: Kernel;
  let edu: EducationModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new EducationModule());
    await kernel.boot();
    edu = kernel.getModule<EducationModule>('education');
  });

  it('creates courses and publishes them', async () => {
    const c = await edu.createCourse({ title: 'Intro to AI', level: 'tertiary', subject: 'CS', instructorId: 't1' });
    assert.equal(c.status, 'draft');
    const pub = await edu.publishCourse(c.id);
    assert.equal(pub.status, 'published');
  });

  it('adds ordered lessons', async () => {
    const c = await edu.createCourse({ title: 'Math 101', level: 'secondary', instructorId: 't1' });
    await edu.addLesson({ courseId: c.id, title: 'Algebra', content: 'Variables and equations' });
    await edu.addLesson({ courseId: c.id, title: 'Geometry', content: 'Shapes and angles', durationMinutes: 30 });
    const lessons = await edu.listLessons(c.id);
    assert.equal(lessons.length, 2);
    assert.equal(lessons[0]!.order, 0);
    assert.equal(lessons[1]!.order, 1);
  });

  it('enrolls students only in published courses', async () => {
    const c = await edu.createCourse({ title: 'Physics', level: 'tertiary', instructorId: 't1' });
    await assert.rejects(() => edu.enroll('s1', c.id), /not published/);
    await edu.publishCourse(c.id);
    const e = await edu.enroll('s1', c.id);
    assert.equal(e.status, 'active');
    await assert.rejects(() => edu.enroll('s1', c.id), /already enrolled/);
  });

  it('records progress and computes completion', async () => {
    const c = await edu.createCourse({ title: 'Bio', level: 'tertiary', instructorId: 't1' });
    await edu.publishCourse(c.id);
    const l1 = await edu.addLesson({ courseId: c.id, title: 'Cells', content: '...' });
    const l2 = await edu.addLesson({ courseId: c.id, title: 'DNA', content: '...' });
    const e = await edu.enroll('s1', c.id);

    await edu.recordProgress(e.id, l1.id, true, 85);
    let p = await edu.getProgress(e);
    assert.equal(p.completedLessons, 1);
    assert.equal(p.completionPct, 50);
    assert.equal(p.avgScore, 85);

    await edu.recordProgress(e.id, l2.id, true, 90);
    p = await edu.getProgress(e);
    assert.equal(p.completionPct, 100);
    assert.equal(p.avgScore, 87.5);

    // Course auto-completes at 100%.
    const enrollments = await edu.listEnrollments({ studentId: 's1' });
    assert.equal(enrollments[0]!.status, 'completed');
  });

  it('allows withdrawal', async () => {
    const c = await edu.createCourse({ title: 'Art', level: 'primary', instructorId: 't1' });
    await edu.publishCourse(c.id);
    const e = await edu.enroll('s1', c.id);
    const w = await edu.withdraw(e.id);
    assert.equal(w.status, 'withdrawn');
  });

  it('filters courses by level and org', async () => {
    await edu.createCourse({ title: 'A', level: 'primary', instructorId: 't1', organizationId: 'org-a' });
    await edu.createCourse({ title: 'B', level: 'tertiary', instructorId: 't1', organizationId: 'org-b' });
    assert.equal((await edu.listCourses('primary')).length, 1);
    assert.equal((await edu.listCourses(undefined, 'org-b')).length, 1);
  });

  it('emits lifecycle events', async () => {
    let enrolled = 0; let lessonDone = 0; let courseDone = 0;
    kernel.bus.on('education.student.enrolled', () => { enrolled++; });
    kernel.bus.on('education.lesson.completed', () => { lessonDone++; });
    kernel.bus.on('education.course.completed', () => { courseDone++; });
    const c = await edu.createCourse({ title: 'X', level: 'professional', instructorId: 't1' });
    await edu.publishCourse(c.id);
    const l = await edu.addLesson({ courseId: c.id, title: 'L1', content: 'x' });
    const e = await edu.enroll('s1', c.id);
    await edu.recordProgress(e.id, l.id, true, 100);
    assert.equal(enrolled, 1);
    assert.equal(lessonDone, 1);
    assert.equal(courseDone, 1); // 1 lesson = 100% → course completed
  });
});
