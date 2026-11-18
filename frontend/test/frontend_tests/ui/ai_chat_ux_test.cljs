;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-chat-ux-test
  "W25: the chat's working state, the selection chip, file attachments,
  the AI tab indicator and the canvas activity effect render."
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react" :as react]
   ["react-dom/client" :as rdc]
   ["react-dom/server" :as rds]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.main.data.ai.chat :as chat]
   [app.main.data.changes :as dch]
   [app.main.store :as st]
   [app.main.ui.ds.tooltip :as tooltip]
   [app.main.ui.workspace.ai.activity.overlay :as overlay]
   [app.main.ui.workspace.ai.chat.files :as files]
   [app.main.ui.workspace.ai.chat.panel :as panel]
   [app.main.ui.workspace.ai.chat.status :as status]
   [app.main.ui.workspace.ai.chat.tab-indicator :as tab-indicator]
   [app.util.i18n :as i18n]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(mf/defc tooltip-stub*
  "Server rendering has no portals; the real tooltip renders into one."
  [{:keys [children]}]
  children)

(def ^:private load-time-store
  "The store the app's refs were derived from. Other test namespaces
  `set!` st/state and st/stream to new instances; the refs keep watching
  these, so every test here points the vars back at them first."
  {:state st/state :stream st/stream})

(defn- use-load-time-store!
  "Point st/state and st/stream at the load-time store; returns the
  previous pair, to restore with `restore-store!`."
  []
  (let [previous {:state st/state :stream st/stream}]
    (set! st/state (:state load-time-store))
    (set! st/stream (:stream load-time-store))
    previous))

(defn- restore-store!
  [{:keys [state stream]}]
  (set! st/state state)
  (set! st/stream stream))

(def ^:private file-id (uuid/next))
(def ^:private page-id (uuid/next))

(defn- workspace-state
  "Store state with one page holding `shapes`, `selected` ids and the
  chat state `chat`."
  [shapes selected chat]
  {:current-file-id file-id
   :current-page-id page-id
   :files {file-id {:data {:pages-index {page-id {:objects (into {} (map (juxt :id identity)) shapes)}}}}}
   :workspace-local {:selected selected}
   :workspace-layout #{:layers}
   :penforge {:connection {:status :connected}
              :chat (merge chat/empty-chat {:conversation-id "c1"} chat)}})

(defn- with-state
  "Run `f` with the store holding `state`, then restore it."
  [state f]
  (let [previous (use-load-time-store!)
        old      @st/state]
    (reset! st/state state)
    (try
      (f)
      (finally
        (reset! st/state old)
        (restore-store! previous)))))

(defn- render-static
  [element]
  (with-redefs [tooltip/tooltip* tooltip-stub*
                ;; `tr` has a 1-arity and a variadic arity; `mock/stub` does not
                ;; forward rest args, so a plain multi-arity fn
                i18n/tr (fn
                          ([key] key)
                          ([key & args] (str/join " " (cons key args))))]
    (rds/renderToStaticMarkup element)))

;; --- Files

(t/deftest file-types-come-from-the-browser-or-the-extension
  (t/is (= "image/png" (files/file-type "a.png" "image/png")))
  (t/is (= "text/markdown" (files/file-type "DESIGN.md" "")))
  (t/is (= "text/markdown" (files/file-type "notes.MARKDOWN" "application/octet-stream")))
  (t/is (= "application/pdf" (files/file-type "spec.pdf" "")))
  (t/is (nil? (files/file-type "logo.svg" "image/svg+xml")))
  (t/is (nil? (files/file-type "README" ""))))

(t/deftest files-are-checked-before-reading
  (let [mb    (* 1024 1024)
        {:keys [accepted problems]}
        (files/check-files [{:kind "file" :size (* 11 mb)}]
                           [{:name "a.png" :mime "image/png" :size 100}
                            {:name "tool.exe" :mime "application/x-msdownload" :size 10}
                            {:name "big.png" :mime "image/png" :size (* 6 mb)}
                            {:name "spec.pdf" :mime "" :size (* 10 mb)}
                            {:name "small.pdf" :mime "application/pdf" :size (* 8 mb)}
                            {:name "DESIGN.md" :mime "" :size 200}])]
    (t/is (= ["a.png" "small.pdf" "DESIGN.md"] (mapv :name accepted)))
    (t/is (= ["text/markdown"] (mapv :mime (filter #(= "DESIGN.md" (:name %)) accepted)))
          "the extension fixes the browser's empty type")
    (t/is (= [[:type "tool.exe"] [:size "big.png" 5] [:total "spec.pdf" 20]]
             (mapv #(vec (remove nil? ((juxt :code :name :limit) %))) problems))))
  (let [pending (vec (repeat 10 {:kind "file" :size 1}))]
    (t/is (= [:count] (mapv :code (:problems (files/check-files pending [{:name "a.txt" :mime "text/plain" :size 1}])))))))

;; --- Status

(t/deftest elapsed-time-reads-like-a-clock
  (t/is (= "0:00" (status/format-elapsed 0)))
  (t/is (= "0:09" (status/format-elapsed 9999)))
  (t/is (= "1:05" (status/format-elapsed 65000)))
  (t/is (= "1:00:01" (status/format-elapsed 3601000))))

(defn- render-status
  [chat]
  (render-static (mf/element status/work-status* #js {:chat (merge chat/empty-chat chat)})))

(t/deftest the-status-shows-work-waiting-and-the-end
  (t/is (= "" (render-status {})) "nothing before the first message")

  (let [markup (render-status {:status :streaming
                               :activity {:started-at (- (js/Date.now) 65000)}
                               :entries [{:kind :user :id "u"}
                                         {:kind :tool :id "t" :status :running :summary "Reading the design"}]})]
    (t/is (str/includes? markup "Reading the design"))
    (t/is (str/includes? markup "1:0") "elapsed time")
    (t/is (str/includes? markup "penforge.chat.input.stop"))
    (t/is (str/includes? markup "role=\"status\"")))

  (let [markup (render-status {:status :streaming
                               :activity {:started-at (js/Date.now)}
                               :entries [{:kind :permission :id "p" :title "t" :risk :low}]})]
    (t/is (str/includes? markup "penforge.chat.status.waiting")))

  (t/is (str/includes? (render-status {:activity {:started-at 0 :ended-at 83000 :outcome :done}})
                       "penforge.chat.status.done"))
  (t/is (str/includes? (render-status {:activity {:started-at 0 :ended-at 83000 :outcome :done}})
                       "1:23"))
  (t/is (str/includes? (render-status {:activity {:started-at 0 :ended-at 1 :outcome :error}})
                       "penforge.chat.status.failed"))
  (t/is (str/includes? (render-status {:activity {:started-at 0 :ended-at 1 :outcome :done :from 0}
                                       :entries [{:kind :user :id "u"}
                                                 {:kind :tool :id "t" :status :error :summary "x"}]})
                       "penforge.chat.status.done-with-errors 1")
        "a finished run with failed steps says so")
  (t/is (str/includes? (render-status {:activity {:started-at 0 :ended-at 1 :outcome :cancelled}})
                       "penforge.chat.status.cancelled")))

;; --- Panel

(t/deftest the-panel-shows-the-selection-files-and-status
  (let [title  (cts/setup-shape {:type :text :name "Title"})
        state  (workspace-state
                [title]
                #{(:id title)}
                {:status :streaming
                 :activity {:started-at (js/Date.now)}
                 :attachments [{:kind "file" :id "f1" :name "shot.png" :mime "image/png"
                                :size 3 :base64 "AAAA"}
                               {:kind "file" :id "f2" :name "DESIGN.md" :mime "text/markdown"
                                :size 3 :base64 "AAAA"}]
                 :entries [{:kind :user :id "u1" :text "build this"
                            :attachments [{:kind "file" :name "spec.pdf" :mime "application/pdf"
                                           :size 9 :path ".penforge/uploads/x-spec.pdf"}]}]})
        markup (with-state state #(render-static (mf/element panel/chat-panel* #js {})))]
    (t/is (str/includes? markup "data-testid=\"ai-chat-selection\""))
    (t/is (str/includes? markup "Title"))
    (t/is (str/includes? markup "src=\"data:image/png;base64,AAAA\""))
    (t/is (str/includes? markup "DESIGN.md"))
    (t/is (str/includes? markup "spec.pdf") "history entries show their files")
    (t/is (str/includes? markup "data-testid=\"ai-chat-status\""))
    (t/is (str/includes? markup "type=\"file\""))
    (t/is (str/includes? markup "accept=\"") "the picker offers the accepted types")))

(t/deftest a-removed-selection-is-not-offered-again
  (let [title  (cts/setup-shape {:type :text :name "Title"})
        state  (workspace-state [title] #{(:id title)} {:dismissed-selection #{(:id title)}})
        markup (with-state state #(render-static (mf/element panel/chat-panel* #js {})))]
    (t/is (not (str/includes? markup "ai-chat-selection")))))

;; --- Tab indicator

(t/deftest the-tab-indicator-shows-only-out-of-view
  (t/is (= "working" (tab-indicator/indicator-state "working" false)))
  (t/is (nil? (tab-indicator/indicator-state "working" true)))
  (t/is (nil? (tab-indicator/indicator-state nil false)))
  (t/is (= "" (with-state (workspace-state [] #{} {:status :streaming})
                #(render-static (mf/element tab-indicator/tab-indicator* #js {}))))
        "it draws nothing itself"))

;; --- Canvas activity

(t/deftest commits-name-the-shapes-they-touch
  (let [a (uuid/next) b (uuid/next) c (uuid/next) other (uuid/next)]
    (t/is (= #{a b c}
             (overlay/changed-ids [{:type :add-obj :id a :page-id page-id}
                                   {:type :mod-obj :id b :page-id page-id}
                                   {:type :mov-objects :parent-id c :shapes [a] :page-id page-id}
                                   {:type :mod-obj :id other :page-id (uuid/next)}
                                   {:type :del-obj :id other :page-id page-id}
                                   {:type :add-color :color {}}]
                                  page-id)))))

(t/deftest regions-cover-each-top-level-board
  (let [board  (cts/setup-shape {:type :frame :name "Home" :x 0 :y 0 :width 400 :height 300})
        child  (cts/setup-shape {:type :rect :x 10 :y 10 :width 50 :height 50
                                 :parent-id (:id board) :frame-id (:id board)})
        lone   (cts/setup-shape {:type :rect :x 1000 :y 0 :width 20 :height 20})
        objects {(:id board) board (:id child) child (:id lone) lone}]
    (t/is (= (:id board) (overlay/root-id objects (:id child))))
    (let [regions (overlay/regions objects #{(:id child) (:id lone) (uuid/next)})]
      (t/is (= 2 (count regions)))
      (t/is (= #{(:id board) (:id lone)} (set (map :key regions))))
      (t/is (= [10 10 50 50]
               (let [{:keys [x y width height]} (:rect (first (filter #(= (:id board) (:key %)) regions)))]
                 [x y width height]))
            "only the changed child glows, not the whole board"))))

(t/deftest the-work-starts-from-the-attached-layers
  (let [id (uuid/next)]
    (t/is (= #{id}
             (overlay/attached-ids {:entries [{:kind :user :attachments [{:kind "node" :page-id (str page-id)
                                                                          :node-id (str id)}
                                                                         {:kind "node" :page-id "other"
                                                                          :node-id (str (uuid/next))}]}
                                              {:kind :assistant}]}
                                   page-id)))
    (t/is (= #{} (overlay/attached-ids {:entries []} page-id)))))

(defn- next-immediate
  []
  (js/Promise. (fn [resolve] (js/setImmediate resolve))))

(defn- ^:async with-mounted-overlay
  "Mount `ai-activity*` in a jsdom SVG with the store holding `state`,
  run `(test-fn container)` and unmount."
  [state test-fn]
  (let [dom          (JSDOM. "<!doctype html><html><body><svg id='root'></svg></body></html>")
        window       (.-window dom)
        document     (.-document window)
        old-window   (.-window js/globalThis)
        old-document (.-document js/globalThis)
        old-act      (.-IS_REACT_ACT_ENVIRONMENT js/globalThis)
        previous     (use-load-time-store!)
        old-state    @st/state
        container    (.getElementById document "root")]
    (set! (.-window js/globalThis) window)
    (set! (.-document js/globalThis) document)
    (set! (.-IS_REACT_ACT_ENVIRONMENT js/globalThis) true)
    (reset! st/state state)
    (try
      (let [root (rdc/createRoot container)]
        (try
          (await (react/act #(.render root (mf/element overlay/ai-activity* #js {:zoom 2 :pageId page-id}))))
          (await (test-fn container))
          (finally
            (await (react/act #(.unmount root))))))
      (finally
        (reset! st/state old-state)
        (restore-store! previous)
        (.close window)
        (set! (.-window js/globalThis) old-window)
        (set! (.-document js/globalThis) old-document)
        (set! (.-IS_REACT_ACT_ENVIRONMENT js/globalThis) old-act)))))

(defn- region-count
  [container]
  (.-length (.querySelectorAll container "[data-testid='ai-activity'] > g")))

(def ^:private attached (cts/setup-shape {:type :rect :name "Button" :x 0 :y 0 :width 40 :height 20}))
(def ^:private added (cts/setup-shape {:type :rect :name "Card" :x 500 :y 0 :width 100 :height 80}))

(defn- ai-commit
  "A local commit event as the AI's plugin makes it, adding `shape`."
  [shape]
  (ptk/reify ::dch/commit
    cljs.core/IDeref
    (-deref [_]
      {:source :local
       :redo-changes [{:type :add-obj :id (:id shape) :page-id page-id}]})))

(t/deftest ^:async the-glow-follows-ai-commits-and-leaves-with-the-run
  (await
   (with-mounted-overlay
     (workspace-state [attached added] #{}
                      {:status :streaming
                       :entries [{:kind :user :id "u1"
                                  :attachments [{:kind "node" :page-id (str page-id)
                                                 :node-id (str (:id attached))}]}]})
     (^:async fn [container]
       (t/is (= 1 (region-count container)) "the attached layer glows as soon as the work starts")
       (t/is (some? (.querySelector container "[data-testid='ai-activity'] text")) "with its AI badge")

       (await (react/act #(st/emit! (ai-commit added))))
       (await (next-immediate))
       (await (react/act #(js/Promise.resolve nil)))
       (t/is (= 2 (region-count container)) "a shape the AI adds glows too")

       (await (react/act #(swap! st/state assoc-in [:penforge :chat :status] :idle)))
       (t/is (some? (.querySelector container "[data-testid='ai-activity'][class*='leaving']"))
             "the glow fades out when the run ends")))))

(t/deftest ^:async no-glow-without-ai-work
  (await
   (with-mounted-overlay
     (workspace-state [attached] #{} {})
     (^:async fn [container]
       (await (react/act #(st/emit! (ai-commit attached))))
       (await (next-immediate))
       (t/is (= 0 (region-count container)) "the user's own edits outside a run never glow")))))
