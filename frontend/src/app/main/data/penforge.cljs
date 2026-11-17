;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.penforge
  "Penforge persona (designer/developer, a profile prop) and platform
  (web/mobile, a per project setting).

  Persona lives in `[:profile :props :penforge-persona]`. Project
  platforms live in `[:penforge-project-settings <project-id>]` once
  fetched. Everything here is a no-op unless the `:ai` flag is on."
  (:require
   [app.common.data.macros :as dm]
   [app.common.logging :as log]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.profile :as du]
   [app.main.repo :as rp]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(log/set-level! :warn)

(def personas #{:designer :developer})
(def platforms #{:web :mobile})

(def default-persona :designer)

(defn enabled?
  []
  (contains? cf/flags :ai))

;; --- Persona

(defn role->persona
  "Maps the onboarding role answer (step 1) to a persona. Returns nil
  for roles that say nothing about it, so the user is asked later."
  [role]
  (case role
    "developer" :developer
    ("ux" "designer") :designer
    nil))

(defn get-persona
  "The persona stored in the profile, or nil when none was chosen."
  [profile]
  (let [persona (dm/get-in profile [:props :penforge-persona])
        persona (if (string? persona) (keyword persona) persona)]
    (when (contains? personas persona)
      persona)))

(defn current-persona
  "The persona to use for the logged in profile: the stored one or the
  default."
  [state]
  (or (get-persona (:profile state)) default-persona))

(defn persona-pending?
  "True when the logged in profile still has to choose a persona."
  [profile]
  (and (enabled?)
       (some? (:id profile))
       (not= uuid/zero (:id profile))
       (nil? (get-persona profile))))

(defn set-persona
  [persona]
  (assert (contains? personas persona) "expected a valid persona")
  (du/update-profile-props {:penforge-persona persona}))

;; --- Platform (project settings)

(defn get-project-platform
  [state project-id]
  (dm/get-in state [:penforge-project-settings project-id]))

(defn current-platform
  "The platform of the project of the open file, or nil when unknown."
  [state]
  (get-project-platform state (:current-project-id state)))

(defn- project-settings-fetched
  [settings]
  (ptk/reify ::project-settings-fetched
    ptk/UpdateEvent
    (update [_ state]
      (reduce (fn [state {:keys [project-id platform]}]
                (assoc-in state [:penforge-project-settings project-id] platform))
              state
              settings))))

(defn fetch-team-project-settings
  [team-id]
  (assert (uuid? team-id) "expected a valid team id")
  (ptk/reify ::fetch-team-project-settings
    ptk/WatchEvent
    (watch [_ _ _]
      (if (enabled?)
        (->> (rp/cmd! :get-penforge-team-project-settings {:team-id team-id})
             (rx/map project-settings-fetched)
             (rx/catch (fn [cause]
                         (log/warn :hint "unable to fetch project settings" :cause cause)
                         (rx/empty))))
        (rx/empty)))))

(defn fetch-project-settings
  "Loads the settings of one project (W04 emits it for the project of
  the open file before sending `context.set`)."
  [project-id]
  (assert (uuid? project-id) "expected a valid project id")
  (ptk/reify ::fetch-project-settings
    ptk/WatchEvent
    (watch [_ _ _]
      (if (enabled?)
        (->> (rp/cmd! :get-penforge-project-settings {:project-id project-id})
             (rx/map (fn [settings]
                       (project-settings-fetched (if settings [settings] []))))
             (rx/catch (fn [cause]
                         (log/warn :hint "unable to fetch project settings" :cause cause)
                         (rx/empty))))
        (rx/empty)))))

(defn update-project-settings
  [project-id platform]
  (assert (uuid? project-id) "expected a valid project id")
  (assert (contains? platforms platform) "expected a valid platform")
  (ptk/reify ::update-project-settings
    ptk/UpdateEvent
    (update [_ state]
      (assoc-in state [:penforge-project-settings project-id] platform))

    ptk/WatchEvent
    (watch [_ _ _]
      (->> (rp/cmd! :update-penforge-project-settings
                    {:project-id project-id :platform platform})
           (rx/map #(project-settings-fetched [%]))))))

;; --- Seed boards of a new file

(def ^:private safe-area-color "#FF3277")

(defn platform-boards
  "The boards a new file of a project with `platform` starts with
  (wiki architecture §8). Guides are horizontal, relative to the
  board top."
  [platform]
  (case platform
    :web    [{:name "Desktop" :width 1440 :height 1024}
             {:name "Mobile" :width 390 :height 844}]
    :mobile [{:name "iPhone" :width 390 :height 844
              :guides [47 (- 844 34)]}
             {:name "Android" :width 412 :height 915}]
    []))

(def ^:private board-gap 100)

(defn platform-board-changes
  "Redo changes that add the boards of `platform` to the empty page
  `page-id`, laid out left to right."
  [platform page-id]
  (loop [boards  (platform-boards platform)
         x       0
         changes []]
    (if-let [{:keys [name width height guides]} (first boards)]
      (let [board-id (uuid/next)
            board    (cts/setup-shape {:type :frame
                                       :id board-id
                                       :name name
                                       :x x
                                       :y 0
                                       :width width
                                       :height height
                                       :parent-id uuid/zero
                                       :frame-id uuid/zero})
            add      {:type :add-obj
                      :id board-id
                      :page-id page-id
                      :parent-id uuid/zero
                      :frame-id uuid/zero
                      :obj board}
            guides   (map (fn [offset]
                            (let [guide-id (uuid/next)]
                              {:type :set-guide
                               :page-id page-id
                               :id guide-id
                               :params {:id guide-id
                                        :axis :y
                                        :position offset
                                        :frame-id board-id
                                        :color safe-area-color}}))
                          guides)]
        (recur (rest boards)
               (+ x width board-gap)
               (-> changes (conj add) (into guides))))
      changes)))

(defn seed-file-boards
  "Adds the platform boards to a freshly created `file` when its project
  has a known platform. Answers an observable with the file; a failure
  is logged and leaves the file empty, it never blocks the creation."
  [state {:keys [id project-id data revn vern features] :as file}]
  (let [platform (get-project-platform state project-id)
        page-id  (-> data :pages first)]
    (if (and (enabled?) (contains? platforms platform) (uuid? page-id))
      (->> (rp/cmd! :update-file
                    (cond-> {:id id
                             :session-id (or (:session-id state) cf/session-id)
                             :revn (or revn 0)
                             :vern (or vern 0)
                             :changes (platform-board-changes platform page-id)}
                      (some? features)
                      (assoc :features features)))
           (rx/map (constantly file))
           (rx/catch (fn [cause]
                       (log/warn :hint "unable to seed platform boards"
                                 :file-id (dm/str id)
                                 :cause cause)
                       (rx/of file))))
      (rx/of file))))
