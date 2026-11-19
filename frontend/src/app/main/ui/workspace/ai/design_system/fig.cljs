;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.design-system.fig
  "Icons from a Figma `.fig` file (W29). W12's importer (the
  `:import-binfile` job, kind \"fig\") turns the file into a temporary
  Penpot file in the team's drafts; the icons of that file (icon-like
  components, else small vector shapes) are rendered to SVG here and
  sent to the daemon's `design-system-icons` workflow, which sanitizes
  and normalizes them like a GitHub icon set. The temporary file is
  deleted afterwards."
  (:require
   [app.common.data.macros :as dm]
   [app.common.logging :as log]
   [app.main.data.ai.design-system :as ds]
   [app.main.data.jobs :as dj]
   [app.main.data.uploads :as uploads]
   [app.main.features.pointer-map :as fpmap]
   [app.main.repo :as rp]
   [app.util.code-gen.markup-svg :as markup-svg]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(def max-icons
  "Most icons sent to the daemon (its limit too)."
  3000)

(def fig-path (conj ds/state-path :fig))

(defn- set-status
  [status & {:as extra}]
  (fn [state]
    (assoc-in state fig-path (merge {:status status} extra))))

(defn file-icons
  "The icons of an imported file as `{:name :group :svg}`; shapes that
  fail to render are left out."
  [data]
  (->> (ds/icon-candidates data)
       (take max-icons)
       (keep (fn [{:keys [id page-id name group]}]
               (let [objects (dm/get-in data [:pages-index page-id :objects])
                     shape   (get objects id)]
                 (try
                   (let [svg (markup-svg/generate-svg objects shape)]
                     (when (str/starts-with? svg "<svg")
                       {:name (or (not-empty (str/trim (str name))) "icon")
                        :group group
                        :svg svg}))
                   (catch :default cause
                     (log/warn :hint "unable to render an icon" :name name :cause cause)
                     nil)))))
       (vec)))

(defn completed-file-id
  "File id of a finished import job, or an error."
  [{:keys [status result error]}]
  (case status
    "completed" (or (first (:file-ids result))
                    (throw (ex-info "the import made no file" {})))
    "failed"    (throw (ex-info "the import failed" {:error error}))
    "cancelled" (throw (ex-info "the import was cancelled" {}))
    nil))

(defn job-file-id
  "The file id of an import job, from the emissions of
  `app.main.data.jobs/watch-job`: one value when it completes, an error
  when it fails or is cancelled; progress emissions are skipped."
  [job-events]
  (->> job-events
       (rx/map completed-file-id)
       (rx/filter some?)
       (rx/take 1)))

(defn- delete-file!
  [file-id]
  (->> (rp/cmd! :delete-file {:id file-id})
       (rx/catch (fn [_] (rx/of nil)))
       (rx/subs! (constantly nil) (constantly nil) (constantly nil))))

(defn import-fig-icons
  "Imports the icons of a `.fig` file (a browser File) into the open
  design system file."
  [file]
  (let [file-name (.-name ^js file)]
    (ptk/reify ::import-fig-icons
      ptk/WatchEvent
      (watch [_ state _]
        (let [ws-conn    (:ws-conn state)
              project-id (dm/get-in state [:profile :default-project-id])
              features   (get state :features)
              temp-name  (str "[Penforge] " (str/replace file-name #"(?i)\.fig$" "") " icons")]
          (if-not (uuid? project-id)
            (rx/of (set-status :error :code "no-drafts"))
            (rx/concat
             (rx/of (set-status :uploading))
             (->> (uploads/upload-blob-chunked file)
                  (rx/mapcat (fn [{:keys [session-id]}]
                               (rp/cmd! :create-import-binfile-job
                                        {:params {:project-id project-id
                                                  :name temp-name
                                                  :version "fig"}
                                         :upload-id session-id})))
                  (rx/mapcat (fn [{job-id :id}]
                               (rx/concat
                                (rx/of (set-status :importing))
                                (->> (job-file-id (dj/watch-job ws-conn job-id))
                                     (rx/mapcat
                                      (fn [file-id]
                                        (rx/concat
                                         (rx/of (set-status :reading))
                                         (->> (rp/cmd! :get-file {:id file-id :features features})
                                              (rx/mapcat fpmap/resolve-file)
                                              (rx/map (fn [{:keys [data]}] (file-icons data)))
                                              (rx/finalize #(delete-file! file-id))
                                              (rx/map (fn [icons]
                                                        (if (empty? icons)
                                                          (set-status :error :code "no-icons")
                                                          {::icons icons})))))))))))
                  (rx/mapcat (fn [item]
                               (if (and (map? item) (contains? item ::icons))
                                 (let [icons (::icons item)]
                                   (rx/of (set-status :sent :count (count icons))
                                          (ds/import-svg-icons icons (str "fig:" file-name))))
                                 (rx/of item))))
                  (rx/catch (fn [cause]
                              (log/error :hint "unable to read icons from a .fig file" :cause cause)
                              (rx/of (set-status :error :code "import-failed"))))))))))))
