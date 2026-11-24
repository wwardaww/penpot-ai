;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.design-system
  "Penforge design system files (W29).

  A design system is a Penpot file in the team project \"Design
  Systems\" (created on first use), marked with the file-level shared
  plugin data `penforge` / `designSystem` (JSON `{version, name,
  createdAt, generatedAt?, publishAsked?, icons?}`). The daemon builds
  it (`design-system-generate`, `design-system-icons`) and it becomes a
  Penpot shared library when the user agrees. See
  `wiki/research/design-system-library.md`.

  In the workspace such a file opens in design-system mode: the AI chat
  opens with a start card and the app actions (Build, preview,
  publish…) are hidden through the action registry guard."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.features :as cfeat]
   [app.common.files.helpers :as cfh]
   [app.common.json :as json]
   [app.common.logging :as log]
   [app.config :as cf]
   [app.main.data.ai.chat :as chat]
   [app.main.data.common :as dcm]
   [app.main.data.helpers :as dsh]
   [app.main.data.notifications :as ntf]
   [app.main.data.plugins :as dp]
   [app.main.data.workspace.libraries :as dwl]
   [app.main.repo :as rp]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [clojure.set :as set]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(log/set-level! :info)

;; --- Constants

(def project-name
  "Name of the team project that holds the design systems. Penpot
  projects have no properties, so the name marks it."
  "Design Systems")

(def plugin-namespace
  "Namespace of Penforge's shared plugin data in file data."
  :shared/penforge)

(def marker-key
  "File-level shared plugin data key of the design system marker."
  "designSystem")

(def generate-workflow "design-system-generate")
(def icons-workflow "design-system-icons")

(def hidden-actions
  "AI actions that make no sense in a design system file: it builds no
  app and has no screens."
  #{:ai/build :ai/instruct :ai/preview :ai/share :ai/accounts :ai/phone-live
    :ai/visual-qa :ai/token-sync :ai/generate-screen :ai/wire-prototype
    :ai/adapt-mobile :ai/adapt-desktop :ai/design-md})

(def state-path [:penforge :design-system])

;; --- Pure helpers

(defn design-systems-project
  "The team project that holds the design systems: the oldest
  non-deleted, non-default project named `project-name`, or nil."
  [projects]
  (->> (if (map? projects) (vals projects) projects)
       (remove :deleted-at)
       (remove :is-default)
       (filter #(= project-name (:name %)))
       (sort-by #(str (:created-at %)))
       (first)))

(defn parse-marker
  "The marker map of a marker JSON string, or nil."
  [value]
  (when (and (string? value) (not (str/blank? value)))
    (try
      (let [marker (json/decode value)]
        (when (map? marker) marker))
      (catch :default _ nil))))

(defn file-marker
  "The design system marker of a file's data, or nil."
  [file-data]
  (parse-marker (dm/get-in file-data [:plugin-data plugin-namespace marker-key])))

(defn marker-json
  "JSON of a fresh marker."
  [name created-at]
  (js/JSON.stringify #js {:version 1 :name name :createdAt created-at}))

(defn design-system-file?
  "Whether the open workspace file is a design system: it has the
  marker, or it lives in the design systems project."
  [state]
  (let [file-data  (dsh/lookup-file-data state)
        project-id (:current-project-id state)
        project    (get-in state [:projects project-id])]
    (boolean
     (and (some? (:current-file-id state))
          (or (some? (file-marker file-data))
              (and (some? project)
                   (= project-name (:name project))
                   (not (:is-default project))))))))

(defn action-visible?
  "Registry guard: hides the app actions in a design system file."
  [state action]
  (not (and (contains? hidden-actions (:id action))
            (design-system-file? state))))

(defn unique-name
  "A new design system name that no file of the team uses."
  [files]
  (let [names (cfh/get-used-names (if (map? files) (vals files) files))]
    (cfh/generate-unique-name (tr "penforge.design-systems.default-name") names :immediate-suffix? true)))

(defn can-edit?
  [state]
  (true? (dm/get-in state [:permissions :can-edit])))

(defn current-marker
  [state]
  (file-marker (dsh/lookup-file-data state)))

(defn shared?
  "Whether the open file is published as a shared library."
  [state]
  (true? (dm/get-in state [:files (:current-file-id state) :is-shared])))

;; --- Icons inside a Penpot file (the `.fig` path)

(def ^:private icon-types
  #{:path :bool :rect :circle :group :frame :svg-raw})

(def max-icon-size
  "Largest side (px) of a shape taken as an icon."
  128)

(defn- descendants-of
  [objects shape]
  (cfh/get-children objects (:id shape)))

(defn icon-shape?
  "Whether a shape looks like an icon: small, about square, made of
  vectors only (no text, no image fill)."
  [objects {:keys [width height type] :as shape}]
  (let [w (or width 0)
        h (or height 0)]
    (and (contains? icon-types type)
         (pos? w) (pos? h)
         (<= w max-icon-size) (<= h max-icon-size)
         (<= 0.5 (/ w h) 2)
         (every? (fn [child]
                   (and (contains? icon-types (:type child))
                        (not (some :fill-image (:fills child)))))
                 (cons shape (descendants-of objects shape))))))

(defn- component-path
  [component]
  (->> (str/split (or (:path component) "") #"\s*/\s*")
       (remove str/blank?)
       (str/join "/")))

(defn icon-candidates
  "Icons of a file's data: the main instances of components that look
  like icons; without any, the top-level vector shapes of every page
  that look like icons. Each item is `{:id :name :group :page-id}`."
  [data]
  (let [components (:components data)
        pages      (map #(get-in data [:pages-index %]) (:pages data))
        mains      (for [page pages
                         :let [objects (:objects page)]
                         shape (vals objects)
                         :when (and (:main-instance shape)
                                    (some? (:component-id shape))
                                    (icon-shape? objects shape))
                         :let [component (get components (:component-id shape))]
                         :when (and component (not (:deleted component)))]
                     {:id (:id shape)
                      :page-id (:id page)
                      :name (or (:name component) (:name shape))
                      :group (component-path component)})]
    (if (seq mains)
      (vec mains)
      (vec (for [page pages
                 :let [objects (:objects page)]
                 shape (vals objects)
                 :let [parent (get objects (:parent-id shape))]
                 :when (and (not= (:id shape) (:parent-id shape))
                            (some? parent)
                            (or (cfh/root? parent) (cfh/frame-shape? parent))
                            (not (cfh/frame-shape? shape))
                            (icon-shape? objects shape))]
             {:id (:id shape)
              :page-id (:id page)
              :name (:name shape)
              :group ""})))))

;; --- Events: dashboard

(defn- project-stored
  [project]
  (fn [state]
    (assoc-in state [:projects (:id project)] project)))

(defn- ensure-project
  "The design systems project of the team, created when missing."
  [state team-id]
  (if-let [project (design-systems-project (dsh/lookup-team-projects state team-id))]
    (rx/of project)
    (rp/cmd! :create-project {:team-id team-id :name project-name})))

(defn- mark-file
  "Writes the marker into a new file right after its creation (the same
  way W05 seeds platform boards)."
  [state {:keys [id revn vern features] :as file} name]
  (->> (rp/cmd! :update-file
                (cond-> {:id id
                         :session-id (or (:session-id state) cf/session-id)
                         :revn (or revn 0)
                         :vern (or vern 0)
                         :changes [{:type :set-plugin-data
                                    :object-type :file
                                    :namespace plugin-namespace
                                    :key marker-key
                                    :value (marker-json name (.toISOString (js/Date.)))}]}
                  (some? features)
                  (assoc :features features)))
       (rx/map (constantly file))
       (rx/catch (fn [cause]
                   ;; the workspace writes the marker on open when it is missing
                   (log/warn :hint "unable to mark the design system file"
                             :file-id (dm/str id)
                             :cause cause)
                   (rx/of file)))))

(defn create-design-system
  "Dashboard \"+ Design System\": an empty file in the design systems
  project (created on first use), marked, opened in the workspace."
  []
  (ptk/reify ::create-design-system
    ptk/WatchEvent
    (watch [_ state _]
      (let [team-id  (:current-team-id state)
            name     (unique-name (dsh/lookup-team-files state team-id))
            features (-> (get state :features)
                         (set/difference cfeat/frontend-only-features))]
        (->> (ensure-project state team-id)
             (rx/mapcat
              (fn [project]
                (rx/concat
                 (rx/of (project-stored project))
                 (->> (rp/cmd! :create-file {:name name
                                             :project-id (:id project)
                                             :features features})
                      (rx/mapcat #(mark-file state % name))
                      (rx/map (fn [file]
                                (dcm/go-to-workspace :team-id team-id
                                                     :file-id (:id file))))))))
             (rx/catch (fn [cause]
                         (log/error :hint "unable to create a design system" :cause cause)
                         (rx/of (ntf/error (tr "penforge.design-systems.create-failed"))))))))))

(defn fetch-design-systems
  "Answers an observable with the design systems of a team: the files of
  the design systems project, each with its library summary, newest
  first. Empty when the project does not exist yet."
  [projects]
  (if-let [project (design-systems-project projects)]
    (->> (rp/cmd! :get-project-files {:project-id (:id project)})
         (rx/mapcat
          (fn [files]
            (if (empty? files)
              (rx/of [])
              (->> (rx/from (sort-by #(str (:modified-at %)) #(compare %2 %1) files))
                   (rx/merge-map
                    (fn [file]
                      (->> (rp/cmd! :get-file-summary {:id (:id file)})
                           (rx/map #(assoc file :library-summary %))
                           (rx/catch (fn [_] (rx/of file))))))
                   (rx/reduce conj [])
                   (rx/map #(vec (sort-by (fn [f] (str (:modified-at f))) (fn [a b] (compare b a)) %))))))))
    (rx/of [])))

;; --- Events: workspace

(defn ensure-marker
  "Writes the marker into the open file when it lives in the design
  systems project but has none yet (editors only)."
  []
  (ptk/reify ::ensure-marker
    ptk/WatchEvent
    (watch [_ state _]
      (let [file-id (:current-file-id state)
            file    (dsh/lookup-file state file-id)]
        (if (and (uuid? file-id)
                 (can-edit? state)
                 (design-system-file? state)
                 (nil? (current-marker state)))
          (rx/of (dp/set-plugin-data file-id :file plugin-namespace marker-key
                                     (marker-json (or (:name file) project-name)
                                                  (.toISOString (js/Date.)))))
          (rx/empty))))))

(defn enter-mode
  "Design-system mode of an opened file: marker, then the AI chat with
  its start card."
  []
  (ptk/reify ::enter-mode
    ptk/WatchEvent
    (watch [_ state _]
      (if (design-system-file? state)
        (rx/of (ensure-marker)
               (chat/open-chat))
        (rx/empty)))))

(defn start-mode
  "Waits for the opened workspace file, then `enter-mode`."
  []
  (ptk/reify ::start-mode
    ptk/WatchEvent
    (watch [_ state stream]
      (let [file-id (:current-file-id state)]
        (if (and (some? file-id) (= file-id (:workspace-ready state)))
          (rx/of (enter-mode))
          (->> stream
               (rx/filter (ptk/type? :app.main.data.workspace/workspace-initialized))
               (rx/take 1)
               (rx/map (fn [_] (enter-mode)))
               (rx/take-until (rx/filter (ptk/type? :app.main.data.ai.client/finalize) stream))))))))

;; --- Runs

(defn- run-started
  [kind rid]
  (fn [state]
    (assoc-in state (conj state-path :running) {:kind kind :rid rid})))

(defn- run-finished
  "Ends run `rid` (a newer run stays) and keeps its result."
  [rid result]
  (fn [state]
    (cond-> state
      (= rid (get-in state (conj state-path :running :rid)))
      (update-in state-path dissoc :running)

      (some? result)
      (assoc-in (conj state-path :last-result) result))))

(defn- result-of
  "The `result` payload among a run's messages."
  [messages]
  (some #(when (and (= "workflow.event" (:type %)) (= "result" (:kind %)))
           (:payload %))
        messages))

(defn- follow
  "Starts workflow `name` in the chat and folds its result: a generate
  result with `publish` true publishes the file as a shared library."
  [kind name params]
  (let [rid (str (random-uuid))]
    (ptk/reify ::follow
      ptk/WatchEvent
      (watch [_ state stream]
        (let [file-id (:current-file-id state)]
          (rx/merge
           (rx/of (run-started kind rid)
                  (chat/open-chat)
                  (chat/run-workflow name params {:rid rid}))
           (->> (chat/workflow-messages stream rid)
                (rx/reduce conj [])
                (rx/mapcat
                 (fn [messages]
                   (let [result (result-of messages)]
                     (rx/concat
                      (rx/of (run-finished rid (when result {:kind kind :payload result})))
                      (if (and (= kind :generate)
                               (true? (:publish result))
                               (uuid? file-id)
                               (not (shared? state)))
                        (rx/of (dwl/set-file-shared file-id true))
                        (rx/empty))))))
                (rx/catch (fn [cause]
                            (log/warn :hint "design system run failed" :cause cause)
                            (rx/of (run-finished rid nil)))))))))))

(defn generate
  "Builds the design system from a DESIGN.md (`:source \"design-md\"`)
  or a brand description (`:source \"prompt\"`)."
  [{:keys [source text file-name]}]
  (ptk/reify ::generate
    ptk/WatchEvent
    (watch [_ state _]
      (rx/of (follow :generate generate-workflow
                     (d/without-nils {:source source
                                      :text text
                                      :file-name file-name
                                      :shared (shared? state)}))))))

(defn import-github-icons
  "Imports an icon set from a GitHub URL (the daemon shows the license
  and asks first)."
  [url]
  (follow :icons icons-workflow {:source "github" :url (str/trim (str url))}))

(defn import-svg-icons
  "Imports SVG icons taken from a `.fig` file."
  [icons origin]
  (follow :icons icons-workflow {:source "svg" :icons icons :origin origin}))

(defn publish
  "Publishes the open design system as a shared library."
  []
  (ptk/reify ::publish
    ptk/WatchEvent
    (watch [_ state _]
      (let [file-id (:current-file-id state)]
        (if (and (uuid? file-id) (not (shared? state)))
          (rx/of (dwl/set-file-shared file-id true))
          (rx/empty))))))

(defn running
  "The run in progress `{:kind :rid}`, or nil."
  [state]
  (get-in state (conj state-path :running)))
