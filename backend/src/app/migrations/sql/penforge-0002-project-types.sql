-- Penforge (W38): two more project types next to 'web' and 'mobile':
-- 'game' (Game UI for a linked Unity or Unreal Engine folder) and
-- 'existing' (a new look for a linked existing app).
--
-- 0001 declared the CHECK inline, so Postgres named it
-- penforge_project_settings_platform_check.

ALTER TABLE penforge_project_settings
  DROP CONSTRAINT IF EXISTS penforge_project_settings_platform_check;

ALTER TABLE penforge_project_settings
  ADD CONSTRAINT penforge_project_settings_platform_check
      CHECK (platform IN ('web', 'mobile', 'game', 'existing'));
