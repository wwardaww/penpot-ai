;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.auto-name
  "Auto-naming of layers (W16).

  Registers the `:ai/auto-name` action (context menu: the selection;
  main menu and command palette: the page, or the whole file chosen in
  the dialog). The action opens the auto-name dialog, which runs the
  daemon workflow `auto-name` and lists the proposed names. The
  accepted names are applied here, in the browser, as one undo step."
  (:require
   [app.common.types.component :as ctc]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.helpers :as dsh]
   [app.main.data.modal :as modal]
   [app.main.data.penforge :as pf]
   [app.main.data.workspace.libraries :as dwl]
   [app.main.data.workspace.shapes :as dwsh]
   [app.main.data.workspace.undo :as dwu]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   ;; registers the `:penforge-auto-name` modal
   [app.main.ui.workspace.ai.auto-name.dialog]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(defn- renamable?
  "Copies follow their main component, so layers inside a copy are
  never renamed here (a rename would become an override)."
  [shape]
  (and (some? shape)
       (not (ctc/in-component-copy? shape))
       (not (ctc/is-variant-main? shape))
       (not (ctc/is-variant-container? shape))))

(defn can-edit?
  "True when the open file can be changed: edit permission and not in
  read-only mode."
  [state]
  (and (true? (get-in state [:permissions :can-edit]))
       (not (get-in state [:workspace-global :read-only?]))))

(defn plan-renames
  "Group accepted renames by page, keeping only layers that still exist
  and still carry the name they had when the workflow read them.
  `renames` are maps `{:node-id :page-id :old-name :new-name}` with
  string ids (as the daemon sends them). Returns a vector of
  `{:page-id uuid :names {shape-id new-name} :components {component-id
  new-name}}`."
  [objects-by-page renames]
  (->> renames
       (group-by :page-id)
       (keep
        (fn [[page-id items]]
          (let [page-id (uuid/parse* page-id)
                objects (get objects-by-page page-id)
                entries (keep
                         (fn [{:keys [node-id old-name new-name]}]
                           (let [id       (uuid/parse* node-id)
                                 shape    (get objects id)
                                 new-name (str/trim (str new-name))]
                             (when (and (renamable? shape)
                                        (= old-name (:name shape))
                                        (not (str/blank? new-name)))
                               {:id id :shape shape :name new-name})))
                         items)]
            (when (seq entries)
              {:page-id page-id
               :names (into {} (map (juxt :id :name)) entries)
               :components (into {}
                                 (keep (fn [{:keys [shape name]}]
                                         (when (and (some? (:component-id shape))
                                                    (ctc/main-instance? shape))
                                           [(:component-id shape) name])))
                                 entries)}))))
       (vec)))

(defn apply-renames
  "Rename layers as one undo step (all pages together). See
  `plan-renames` for the shape of `renames`."
  [renames]
  (ptk/reify ::apply-renames
    ptk/WatchEvent
    (watch [_ state _]
      (let [page-ids (into #{} (keep (comp uuid/parse* :page-id)) renames)
            objects  (into {}
                           (map (fn [page-id]
                                  [page-id (dsh/lookup-page-objects state page-id)]))
                           page-ids)
            plan     (plan-renames objects renames)
            undo-id  (js/Symbol)]
        (if (empty? plan)
          (rx/empty)
          (rx/concat
           (rx/of (dwu/start-undo-transaction undo-id))
           (rx/from
            (for [{:keys [page-id names]} plan]
              (dwsh/update-shapes (vec (keys names))
                                  (fn [shape]
                                    (assoc shape :name (get names (:id shape) (:name shape))))
                                  {:page-id page-id
                                   :attrs #{:name}})))
           ;; renaming a main instance renames its component too, as
           ;; a manual rename does
           (rx/from
            (for [{:keys [components]} plan
                  [component-id name] components]
              (dwl/rename-component component-id name)))
           (rx/of (dwu/commit-undo-transaction undo-id))))))))

(defn- open-dialog
  [{:keys [scope state selected]}]
  (let [selection? (and (= scope :context-menu) (seq selected))]
    (modal/show :penforge-auto-name
                {:scope (if selection? :selection :page)
                 :node-ids (mapv str selected)
                 :page-id (some-> (:current-page-id state) str)
                 :persona (pf/current-persona state)
                 :on-apply (fn [renames]
                             (st/emit! (apply-renames renames)))})))

(actions/register-action!
 {:id :ai/auto-name
  :label #(tr "penforge.actions.auto-name")
  :icon i/text
  :order 30
  :scopes #{:context-menu :main-menu :command-palette}
  :visible? can-edit?
  :enabled? can-edit?
  :run (fn [context]
         (st/emit! (open-dialog context)))})
