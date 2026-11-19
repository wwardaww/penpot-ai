;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-design-system-test
  "Design system files (W29): the design systems project, the file
  marker, design-system mode and its action guard, and the icons found
  in an imported `.fig` file."
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.all]
   [app.main.data.ai.design-system :as ds]
   [app.main.ui.dashboard.penforge.design-systems.page :as page]
   [cljs.test :as t :include-macros true]))

(def ^:private file-id (uuid/next))
(def ^:private project-id (uuid/next))

(defn- workspace-state
  [& {:keys [plugin-data project-name]}]
  {:current-file-id file-id
   :current-project-id project-id
   :projects {project-id {:id project-id :name (or project-name "Website")}}
   :files {file-id {:id file-id :data {:id file-id :plugin-data plugin-data}}}})

(defn- marked
  [json]
  {ds/plugin-namespace {ds/marker-key json}})

(t/deftest design-systems-project-is-the-oldest-named-project
  (let [projects [{:id 1 :name "Design Systems" :created-at "2026-11-19T10:00:00Z"}
                  {:id 2 :name "Design Systems" :created-at "2026-11-18T10:00:00Z"}
                  {:id 3 :name "Design Systems" :created-at "2026-11-01T10:00:00Z" :deleted-at "x"}
                  {:id 4 :name "Design Systems" :created-at "2026-10-01T10:00:00Z" :is-default true}
                  {:id 5 :name "Website"}]]
    (t/is (= 2 (:id (ds/design-systems-project projects))))
    (t/is (= 2 (:id (ds/design-systems-project (zipmap (map :id projects) projects)))))
    (t/is (nil? (ds/design-systems-project [{:id 5 :name "Website"}])))))

(t/deftest marker-round-trip
  (let [json   (ds/marker-json "Acme" "2026-11-19T10:00:00.000Z")
        marker (ds/parse-marker json)]
    (t/is (= {:version 1 :name "Acme" :created-at "2026-11-19T10:00:00.000Z"} marker))
    (t/is (= marker (ds/file-marker {:plugin-data (marked json)})))
    (t/is (nil? (ds/parse-marker "not json")))
    (t/is (nil? (ds/parse-marker "[1,2]")))
    (t/is (nil? (ds/parse-marker nil)))))

(t/deftest design-system-mode-by-marker-or-project
  (t/is (true? (ds/design-system-file?
                (workspace-state :plugin-data (marked (ds/marker-json "Acme" "now"))))))
  (t/is (true? (ds/design-system-file? (workspace-state :project-name ds/project-name))))
  (t/is (false? (ds/design-system-file? (workspace-state))))
  (t/is (false? (ds/design-system-file? {}))))

(t/deftest guard-hides-app-actions-in-design-system-files
  (let [registry {:ai/build {:id :ai/build :label (constantly "Build") :scopes #{:island} :run identity}
                  :ai/audit {:id :ai/audit :label (constantly "Audit") :scopes #{:island} :run identity}}
        ds-state (workspace-state :project-name ds/project-name)]
    (t/is (= [:ai/audit] (mapv :id (actions/get-actions registry :island ds-state))))
    (t/is (= [:ai/audit :ai/build] (mapv :id (actions/get-actions registry :island (workspace-state)))))
    (t/is (false? (ds/action-visible? ds-state {:id :ai/share})))
    (t/is (true? (ds/action-visible? ds-state {:id :ai/checkpoints})))))

(defn- shape
  [id type parent & {:as attrs}]
  (merge {:id id :type type :parent-id parent :frame-id parent :shapes [] :name (name id)}
         attrs))

(defn- page-data
  [shapes components]
  (let [objects (into {uuid/zero (shape uuid/zero :frame uuid/zero
                                        :shapes (->> shapes (filter #(= uuid/zero (:parent-id %))) (mapv :id)))}
                      (map (juxt :id identity))
                      shapes)]
    {:pages [:p1]
     :pages-index {:p1 {:id :p1 :objects objects}}
     :components components}))

(t/deftest icon-candidates-prefer-icon-like-components
  (let [data (page-data
              [(shape :star :group uuid/zero :width 24 :height 24 :shapes [:star-path]
                      :main-instance true :component-id :c-star)
               (shape :star-path :path :star :width 20 :height 20)
               (shape :card :frame uuid/zero :width 320 :height 200
                      :main-instance true :component-id :c-card)
               (shape :label :group uuid/zero :width 24 :height 24 :shapes [:label-text]
                      :main-instance true :component-id :c-label)
               (shape :label-text :text :label :width 20 :height 12)
               (shape :loose :path uuid/zero :width 24 :height 24)]
              {:c-star {:id :c-star :name "star" :path "Icons / Solid"}
               :c-card {:id :c-card :name "card" :path ""}
               :c-label {:id :c-label :name "label" :path ""}})]
    (t/is (= [{:id :star :page-id :p1 :name "star" :group "Icons/Solid"}]
             (ds/icon-candidates data)))))

(t/deftest icon-candidates-fall-back-to-small-vectors
  (let [data (page-data
              [(shape :arrow :path uuid/zero :width 24 :height 24)
               (shape :wide :path uuid/zero :width 120 :height 10)
               (shape :big :path uuid/zero :width 400 :height 400)]
              {})]
    (t/is (= [:arrow] (mapv :id (ds/icon-candidates data))))))

(t/deftest card-info-reads-the-library-summary
  (t/is (= {:name "Acme" :shared true :colors ["#111111" "#222222"]
            :font-family "Inter" :font-id "gfont-inter"
            :components 12 :variants 3 :tokens 40}
           (page/card-info {:name "Acme"
                            :is-shared true
                            :library-summary {:colors {:count 2 :sample [{:color "#111111"} {:color "#222222"} {:gradient {}}]}
                                              :typographies {:count 1 :sample [{:font-family "Inter" :font-id "gfont-inter"}]}
                                              :components {:count 12}
                                              :variants {:count 3}
                                              :tokens-count 40}})))
  (t/is (= 0 (:components (page/card-info {:name "Empty"})))))
