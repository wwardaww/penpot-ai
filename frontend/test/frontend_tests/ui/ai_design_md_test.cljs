;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-design-md-test
  "DESIGN.md panel (W22): the state the daemon messages build, and the
  panel rendered in each of its states."
  (:require
   ["react-dom/server" :as rds]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.design-md]
   [app.main.ui.hooks :as hooks]
   [app.main.ui.workspace.ai.design-md.panel :as panel]
   [app.main.ui.workspace.ai.design-md.state :as dms]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def ^:private design-md
  "---\nversion: alpha\nname: Acme\ncolors:\n  primary: \"#2B59C3\"\n---\n\n## Overview\n\nCalm and **clear**.\n")

(def ^:private history
  [{:commit "aaaaaaa1111111111111111111111111111111111" :date "2026-11-17T10:00:00+01:00"
    :subject "penforge(design-md): update from the file"}
   {:commit "bbbbbbb2222222222222222222222222222222222" :date "2026-11-16T09:00:00+01:00"
    :subject "penforge(design-md): draft DESIGN.md"}])

(defn- run
  "Fold the messages of one run of workflow `name` into `state`."
  [state name & messages]
  (reduce #(dms/apply-message %1 name %2)
          (dms/start-op state name "rid-1")
          messages))

(defn- result
  [payload]
  {:type "workflow.event" :run-id "run-1" :kind "result" :payload payload})

(def ^:private done
  {:type "workflow.done" :run-id "run-1" :ok true :summary "Done here"})

(def ^:private loaded
  (run dms/initial-state dms/read-workflow
       {:type "workflow.started" :rid "rid-1" :run-id "run-1" :name dms/read-workflow}
       (result {:exists true :content design-md :ref nil :issues [] :history history})
       done))

(def ^:private handlers
  ["onClose" "onMode" "onContent" "onPrompt" "onSave" "onDiscard" "onApply"
   "onExport" "onDraft" "onView" "onCurrent" "onRestore" "onAnswered"])

(defn- render
  [state & {:keys [connected] :or {connected true}}]
  (let [props #js {:state state :connected connected}]
    (doseq [handler handlers]
      (unchecked-set props handler identity))
    ;; tooltips of the icon buttons portal into a node made with the DOM
    (with-redefs [hooks/use-portal-container (fn ([] nil) ([_] nil))]
      (rds/renderToStaticMarkup (mf/element panel/design-md-view* props)))))

(t/deftest read-result-loads-the-file-and-its-history
  (t/is (:loaded loaded))
  (t/is (:exists loaded))
  (t/is (= design-md (:content loaded) (:saved loaded)))
  (t/is (= 2 (count (:history loaded))))
  (t/is (nil? (:op loaded)))
  (t/is (nil? (:notice loaded)) "a read shows no notice")
  (t/is (not (dms/dirty? loaded))))

(t/deftest reading-an-old-version-keeps-the-editor-text
  (let [state (-> loaded
                  (assoc :content "edited")
                  (run dms/read-workflow
                       (result {:exists true :content "old" :ref "bbbbbbb" :issues [] :history history})
                       done))]
    (t/is (= {:ref "bbbbbbb" :content "old" :issues []} (:viewing state)))
    (t/is (= "edited" (:content state)))))

(t/deftest progress-questions-and-failures-are-tracked
  (let [running (run loaded dms/import-workflow
                     {:type "workflow.started" :rid "rid-1" :run-id "run-9" :name dms/import-workflow}
                     {:type "workflow.event" :run-id "run-9" :kind "progress" :payload {:summary "Building components"}}
                     {:type "workflow.event" :run-id "run-9" :kind "question"
                      :payload {:question-id "q1" :text "Go on?" :options [{:id "continue" :label "Yes"}]}})
        failed  (dms/apply-message running dms/import-workflow
                                   {:type "workflow.done" :run-id "run-9" :ok false
                                    :summary "Could not finish" :error "DESIGN.md has errors"})
        refused (dms/apply-message running dms/import-workflow
                                   {:type "error" :rid "rid-1" :code "busy" :message "Busy"})]
    (t/is (dms/busy? running))
    (t/is (= "run-9" (get-in running [:op :run-id])))
    (t/is (= "Building components" (get-in running [:op :progress])))
    (t/is (= "q1" (get-in running [:op :question :question-id])))
    (t/is (nil? (get-in (dms/clear-question running) [:op :question])))
    (t/is (= "DESIGN.md has errors" (:error failed)))
    (t/is (not (dms/busy? failed)))
    (t/is (= "Busy" (:error refused)))))

(t/deftest import-and-export-results-update-the-state
  (let [report   {:checkpoint "Before applying DESIGN.md"
                  :colors {:created ["primary"] :updated [] :unchanged []}
                  :typographies {:created [] :updated [] :unchanged []}
                  :tokens {:created ["color.primary"] :updated [] :unchanged []}
                  :warnings []
                  :components {:tagged [{:key "button-primary"}] :missing ["card"]}}
        imported (run loaded dms/import-workflow (result report) done)
        exported (run loaded dms/export-workflow
                      (result {:content "---\nname: B\n---\n" :commit "c" :issues []})
                      done)]
    (t/is (= report (:report imported)))
    (t/is (= "Done here" (:notice imported)))
    (t/is (= "---\nname: B\n---\n" (:content exported) (:saved exported)))
    (t/is (= [1 0] (dms/report-counts (:colors report))))))

(t/deftest split-front-matter-separates-tokens-and-prose
  (t/is (= {:front-matter "version: alpha\nname: Acme\ncolors:\n  primary: \"#2B59C3\""
            :body "## Overview\n\nCalm and **clear**."}
           (dms/split-front-matter design-md)))
  (t/is (= {:front-matter nil :body "# Title"} (dms/split-front-matter "# Title")))
  (t/is (= "aaaaaaa" (dms/short-commit (:commit (first history))))))

(t/deftest the-panel-renders-in-every-state
  (let [not-connected (render dms/initial-state :connected false)
        loading       (render dms/initial-state)
        empty         (render (assoc dms/initial-state :loaded true))
        preview       (render loaded)
        editing       (render (assoc loaded :mode :edit :content "changed"))
        viewing       (render (assoc loaded :viewing {:ref "bbbbbbb2222" :content "## Old\n" :issues []}))
        busy          (render (-> loaded
                                  (dms/start-op dms/import-workflow "rid-2")
                                  (assoc-in [:op :run-id] "run-2")
                                  (assoc-in [:op :question] {:question-id "q" :text "Apply anyway?"
                                                             :options [{:id "continue" :label "Apply anyway"}]})))
        reported      (render (assoc loaded
                                     :report {:checkpoint "x"
                                              :colors {:created ["a"] :updated ["b"]}
                                              :typographies {:created [] :updated []}
                                              :tokens {:created [] :updated []}
                                              :warnings ["font Nope was not found"]
                                              :components {:tagged [] :missing ["card"]}}
                                     :issues [{:severity "error" :path "colors.a" :message "bad"}]
                                     :error "boom"))]
    (t/is (str/includes? not-connected "penforge.design-md.not-connected"))
    (t/is (str/includes? loading "penforge.design-md.loading"))
    (t/is (str/includes? empty "penforge.design-md.empty.title"))
    (t/is (str/includes? empty "penforge.design-md.create-from-file"))
    (t/is (str/includes? preview "data-testid=\"design-md-panel\""))
    (t/is (str/includes? preview "<strong>clear</strong>"))
    (t/is (str/includes? preview "name: Acme"))
    (t/is (str/includes? preview "penforge(design-md): draft DESIGN.md"))
    (t/is (str/includes? editing "<textarea"))
    (t/is (str/includes? editing "penforge.design-md.unsaved"))
    (t/is (str/includes? viewing "penforge.design-md.restore"))
    (t/is (str/includes? viewing "Old"))
    (t/is (str/includes? busy "Apply anyway"))
    (t/is (str/includes? busy "penforge.design-md.working"))
    (t/is (str/includes? reported "font Nope was not found"))
    (t/is (str/includes? reported "colors.a"))
    (t/is (str/includes? reported "penforge.design-md.error"))))

(t/deftest the-action-is-registered
  (let [action (get @actions/registry :ai/design-md)]
    (t/is (some? action))
    (t/is (= #{:main-menu :command-palette} (:scopes action)))))
