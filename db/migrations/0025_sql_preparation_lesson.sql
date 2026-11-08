-- Add the complete first lesson without renumbering the three existing formal rounds.
ALTER TABLE sql_study_grades DROP CONSTRAINT IF EXISTS sql_study_grades_lesson_check;
ALTER TABLE sql_study_grades ADD CONSTRAINT sql_study_grades_lesson_check CHECK (lesson BETWEEN 0 AND 3);
