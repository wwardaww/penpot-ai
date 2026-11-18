;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.commands.penforge
  "Penforge RPC commands. Every command answers only when the `:ai`
  flag is enabled."
  (:require
   [app.common.exceptions :as ex]
   [app.common.geom.point :as gpt]
   [app.common.schema :as sm]
   [app.config :as cf]
   [app.db :as db]
   [app.db.sql :as-alias sql]
   [app.penforge.bot :as bot]
   [app.penforge.project-settings :as pps]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.comments :as comments]
   [app.rpc.commands.files :as files]
   [app.rpc.commands.projects :as projects]
   [app.rpc.commands.teams :as teams]
   [app.rpc.doc :as-alias doc]
   [app.rpc.retry :as rtry]
   [app.util.services :as sv]))

(defn- check-enabled!
  []
  (when-not (contains? cf/flags :ai)
    (ex/raise :type :restriction
              :code :feature-disabled
              :hint "penforge (ai) features are disabled")))

;; --- QUERY: Get project settings

(def ^:private schema:get-penforge-project-settings
  [:map {:title "get-penforge-project-settings"}
   [:project-id ::sm/uuid]])

(sv/defmethod ::get-penforge-project-settings
  "Returns the Penforge settings of a project, or nil when the project
  has none yet."
  {::doc/added "2.20"
   ::sm/params schema:get-penforge-project-settings
   ::sm/result [:maybe pps/schema:project-settings]}
  [{:keys [::db/pool] :as cfg} {:keys [::rpc/profile-id project-id]}]
  (check-enabled!)
  (projects/check-read-permissions! cfg profile-id project-id)
  (pps/get-project-settings pool project-id))

;; --- QUERY: Get the project settings of a team

(def ^:private schema:get-penforge-team-project-settings
  [:map {:title "get-penforge-team-project-settings"}
   [:team-id ::sm/uuid]])

(sv/defmethod ::get-penforge-team-project-settings
  "Returns the Penforge settings of every project of the team that has
  any (used by the dashboard to badge the project cards)."
  {::doc/added "2.20"
   ::sm/params schema:get-penforge-team-project-settings
   ::sm/result [:vector pps/schema:project-settings]}
  [{:keys [::db/pool] :as cfg} {:keys [::rpc/profile-id team-id]}]
  (check-enabled!)
  (teams/check-read-permissions! cfg profile-id team-id)
  (pps/get-team-project-settings pool team-id))

;; --- MUTATION: Update project settings

(def ^:private schema:update-penforge-project-settings
  [:map {:title "update-penforge-project-settings"}
   [:project-id ::sm/uuid]
   [:platform pps/schema:platform]])

(sv/defmethod ::update-penforge-project-settings
  "Creates or replaces the Penforge settings of a project. Needs edition
  permission on the project."
  {::doc/added "2.20"
   ::sm/params schema:update-penforge-project-settings
   ::sm/result pps/schema:project-settings
   ::db/transaction true}
  [{:keys [::db/conn] :as cfg} {:keys [::rpc/profile-id ::rpc/request-at project-id platform]}]
  (check-enabled!)
  (projects/check-edition-permissions! conn profile-id project-id)
  (pps/upsert-project-settings! conn {:project-id project-id
                                      :platform platform
                                      :timestamp request-at}))

;; --- MUTATION: Comments authored by the Penforge bot
;;
;; The Penforge AI writes its comments (fix notes, replies, audit
;; findings) through these commands so that they show the bot profile
;; as their author. Only the bundled MCP plugin uses them, and only with
;; the `:ai` flag on (the frontend picks them in `app.plugins.comments`);
;; here the caller needs edition permission on the file, never a share
;; link. The caller still pays the comment quotes and stays recorded as
;; the actor of the request in the audit log.

(def ^:private schema:create-penforge-comment-thread
  [:map {:title "create-penforge-comment-thread"}
   [:file-id ::sm/uuid]
   [:position ::gpt/point]
   [:content [:string {:max comments/comment-max-length}]]
   [:page-id ::sm/uuid]
   [:frame-id ::sm/uuid]
   [:mentions {:optional true} [::sm/set ::sm/uuid]]])

(sv/defmethod ::create-penforge-comment-thread
  "Creates a comment thread authored by the Penforge bot. Same params
  and result as `create-comment-thread`, without share links."
  {::doc/added "2.20"
   ::rtry/enabled true
   ::rtry/when rtry/conflict-exception?
   ::sm/params schema:create-penforge-comment-thread}
  [cfg {:keys [::rpc/profile-id file-id] :as params}]
  (check-enabled!)
  (files/check-edition-permissions! cfg profile-id file-id)
  (let [author-id (bot/ensure-profile! cfg)]
    (comments/create-comment-thread! cfg params author-id)))

(def ^:private schema:create-penforge-comment
  [:map {:title "create-penforge-comment"}
   [:thread-id ::sm/uuid]
   [:content [:string {:max comments/comment-max-length}]]
   [:mentions {:optional true} [::sm/set ::sm/uuid]]])

(sv/defmethod ::create-penforge-comment
  "Adds a comment authored by the Penforge bot to a thread. Same params
  and result as `create-comment`, without share links."
  {::doc/added "2.20"
   ::sm/params schema:create-penforge-comment
   ::db/transaction true}
  [{:keys [::db/conn] :as cfg} {:keys [::rpc/profile-id thread-id] :as params}]
  (check-enabled!)
  (let [thread (comments/get-comment-thread conn thread-id ::sql/for-update true)]
    (files/check-edition-permissions! conn profile-id (:file-id thread))
    (let [author-id (bot/ensure-profile! conn)]
      (comments/create-comment! cfg thread params author-id))))
