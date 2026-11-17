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
   [app.common.schema :as sm]
   [app.config :as cf]
   [app.db :as db]
   [app.penforge.project-settings :as pps]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.projects :as projects]
   [app.rpc.commands.teams :as teams]
   [app.rpc.doc :as-alias doc]
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
