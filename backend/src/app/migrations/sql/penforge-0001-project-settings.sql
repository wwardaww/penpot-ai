-- Penforge: per project settings (target platform of the generated app).
--
-- One row per project, created the first time the platform is chosen. A
-- project without a row has no platform yet. The row goes away with its
-- project.

CREATE TABLE penforge_project_settings (
  project_id  uuid PRIMARY KEY
              REFERENCES project(id) ON DELETE CASCADE DEFERRABLE,

  platform    text NOT NULL
              CHECK (platform IN ('web', 'mobile')),

  created_at  timestamptz NOT NULL DEFAULT now(),
  modified_at timestamptz NOT NULL DEFAULT now()
);
