;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.penforge.project-settings
  "Penforge per project settings: the platform (web or mobile) the
  generated app targets. Stored in `penforge_project_settings`, one row
  per project."
  (:require
   [app.common.schema :as sm]
   [app.db :as db]))

(def platforms
  #{:web :mobile})

(def schema:platform
  [::sm/one-of platforms])

(def schema:project-settings
  [:map {:title "PenforgeProjectSettings"}
   [:project-id ::sm/uuid]
   [:platform schema:platform]])

(defn- decode-row
  [{:keys [project-id platform]}]
  {:project-id project-id
   :platform   (keyword platform)})

(def ^:private sql:get-project-settings
  "SELECT project_id, platform
     FROM penforge_project_settings
    WHERE project_id = ?")

(defn get-project-settings
  "Returns the settings of the project, or nil when it has none."
  [conn project-id]
  (some-> (db/exec-one! conn [sql:get-project-settings project-id])
          (decode-row)))

(def ^:private sql:get-team-project-settings
  "SELECT s.project_id, s.platform
     FROM penforge_project_settings AS s
    INNER JOIN project AS p ON (p.id = s.project_id)
    WHERE p.team_id = ?
      AND p.deleted_at IS NULL
    ORDER BY s.project_id")

(defn get-team-project-settings
  "Returns the settings of every live project of the team that has any."
  [conn team-id]
  (->> (db/exec! conn [sql:get-team-project-settings team-id])
       (mapv decode-row)))

(def ^:private sql:upsert-project-settings
  "INSERT INTO penforge_project_settings
          (project_id, platform, created_at, modified_at)
   VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id)
       DO UPDATE SET platform = EXCLUDED.platform,
                     modified_at = EXCLUDED.modified_at
   RETURNING project_id, platform")

(defn upsert-project-settings!
  "Creates or replaces the settings of the project and returns them."
  [conn {:keys [project-id platform timestamp]}]
  (assert (contains? platforms platform) "expected a valid platform")
  (-> (db/exec-one! conn [sql:upsert-project-settings
                          project-id (name platform)
                          timestamp timestamp])
      (decode-row)))
