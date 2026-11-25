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
   [app.common.data :as d]
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
    (t/is (= [[:type "tool.exe"] [:size "big.png" 3.75] [:total "spec.pdf" 20]]
             (mapv #(vec (remove nil? ((juxt :code :name :limit) %))) problems))))
  (let [pending (vec (repeat 10 {:kind "file" :size 1}))]
    (t/is (= [:count] (mapv :code (:problems (files/check-files pending [{:name "a.txt" :mime "text/plain" :size 1}])))))))

(defn- browser-file
  "Stand-in for a browser `File` picked with a folder input."
  [relative-path size]
  #js {:name (last (str/split relative-path "/"))
       :webkitRelativePath relative-path
       :size size})

(t/deftest picked-folders-keep-their-tree-without-tool-folders
  (let [{:keys [name files skipped]}
        (files/folder-entries #js [(browser-file "brand/logo.svg" 10)
                                   (browser-file "brand/icons/home.png" 20)
                                   (browser-file "brand/.git/HEAD" 1)
                                   (browser-file "brand/web/node_modules/x/index.js" 5)
                                   (browser-file "brand/.DS_Store" 2)])]
    (t/is (= "brand" name))
    (t/is (= ["logo.svg" "icons/home.png"] (mapv :path files)))
    (t/is (= [10 20] (mapv :size files)))
    (t/is (= 3 skipped))))

(t/deftest folders-are-checked-whole-against-the-limits
  (let [mb (* 1024 1024)
        ok {:name "brand" :files [{:path "a.png" :size 10} {:path "b/c.svg" :size 5}]}]
    (t/is (= {:name "brand" :files (:files ok) :size 15}
             (:accepted (files/check-folder [] ok))))
    (t/is (= [:folder-empty] (mapv :code (:problems (files/check-folder [] {:name "e" :files []})))))
    (t/is (= [[:folder-count "many" 300]]
             (mapv (juxt :code :name :limit)
                   (:problems (files/check-folder [] {:name "many"
                                                      :files (vec (repeat 301 {:path "a" :size 1}))})))))
    (t/is (= [[:folder-size "video.mp4" 10]]
             (mapv (juxt :code :name :limit)
                   (:problems (files/check-folder [] {:name "v" :files [{:path "video.mp4" :size (* 11 mb)}]})))))
    (t/is (= [:total]
             (mapv :code (:problems (files/check-folder [{:kind "file" :size (* 15 mb)}
                                                         {:kind "folder" :size (* 4 mb)}]
                                                        {:name "x" :files [{:path "a" :size (* 2 mb)}]}))))
          "files, folders and reserved room share the total")
    (t/is (= [:total]
             (mapv :code (:problems (files/check-files [{:kind "folder" :size (* 19 mb)}]
                                                       [{:name "a.png" :mime "image/png" :size (* 2 mb)}]))))
          "a pending folder counts for later files too")))

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
                       "penforge.chat.status.done-with-errors")
        "a finished run with failed steps says so")
  (t/is (str/includes? (render-status {:activity {:started-at 0 :ended-at 1 :outcome :cancelled}})
                       "penforge.chat.status.cancelled"))
  (t/is (str/includes? (render-status {:activity {:started-at 0 :ended-at 1 :outcome :interrupted}})
                       "penforge.chat.status.interrupted"))
  (let [markup (render-status {:runs {"run1" {:status :running :silent true}}
                               :entries [{:kind :question :id "q1" :run-id "run1" :text "Change it there too?"
                                          :options [{:id "apply" :label "Change it everywhere"}]}]})]
    (t/is (str/includes? markup "penforge.chat.status.waiting")
          "a comment fix waiting for an answer shows in the chat")
    (t/is (not (str/includes? markup "penforge.chat.input.stop"))
          "Stop does not reach a silent run")))

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
                                           :size 9 :path ".penforge/uploads/x-spec.pdf"}
                                          {:kind "folder" :name "brand-kit"
                                           :path ".penforge/sources/x-brand-kit"
                                           :files [{:path "a.svg" :size 1} {:path "b.png" :size 2}]}]}
                           {:kind :tool :id "t1" :tool-name "penforge_canvas_check" :status :error
                            :summary "English" :code "boards-overlap" :params {:names ["Android" "Android"]}}
                           {:kind :tool :id "t2" :tool-name "penforge_canvas_check" :status :done
                            :summary "English" :code "style-differs"
                            :params {:board "Android - Ana Sayfa" :source "iPhone" :layers ["Progress Card" "Fab"]}}
                           {:kind :error :id "e1" :code "bad-request" :message "English"
                            :reason "file-size" :params {:name "big.png" :limit-mb 3.75}}]})
        markup (with-state state #(render-static (mf/element panel/chat-panel* #js {})))]
    (t/is (str/includes? markup "data-testid=\"ai-chat-selection\""))
    (t/is (str/includes? markup "Title"))
    (t/is (str/includes? markup "src=\"blob:") "image chips show an object URL")
    (t/is (str/includes? markup "penforge.chat.check.boards-overlap Android Android")
          "the canvas check is worded by the client")
    (t/is (str/includes? markup "penforge.chat.check.style-differs Android - Ana Sayfa iPhone Progress Card, Fab")
          "a style difference with its source is worded by the client")
    (t/is (str/includes? markup "penforge.chat.attach.error.size big.png 3.75")
          "a refused file is worded by the client")
    (t/is (str/includes? markup "DESIGN.md"))
    (t/is (str/includes? markup "spec.pdf") "history entries show their files")
    (t/is (str/includes? markup "penforge.chat.attach.folder-label brand-kit 2")
          "history entries show their folders with the file count")
    (t/is (str/includes? markup "webkitdirectory=\"\"")
          "the folder picker is a directory input")
    (t/is (str/includes? markup "data-testid=\"ai-chat-status\""))
    (t/is (str/includes? markup "type=\"file\""))
    (t/is (str/includes? markup "accept=\"") "the picker offers the accepted types")))

(t/deftest an-answered-permission-is-a-step-above-the-answer
  (let [state   (fn [answer]
                  (workspace-state
                   [] (d/ordered-set)
                   {:status :streaming
                    :entries [{:kind :user :id "u1" :text "Go"}
                              {:kind :assistant :id "a1" :text "The answer"}
                              (cond-> {:kind :permission :id "p1" :title "Write a file"
                                       :description "index.html" :risk :medium}
                                (some? answer) (assoc :answer answer))]}))
        markup  (fn [answer]
                  (with-state (state answer)
                    #(render-static (mf/element panel/chat-panel* #js {}))))
        waiting (markup nil)
        allowed (markup :allowed)]
    (t/is (str/includes? waiting "penforge.chat.permission.allow<"))
    (t/is (not (str/includes? waiting "ai-chat-answered-permission")))
    (t/is (< (str/index-of waiting "The answer") (str/index-of waiting "Write a file"))
          "a card that waits is the last thing in the chat")
    (t/is (str/includes? allowed "ai-chat-answered-permission"))
    (t/is (str/includes? allowed "penforge.chat.permission.allowed"))
    (t/is (not (str/includes? allowed "penforge.chat.permission.deny<")))
    (t/is (< (str/index-of allowed "Write a file") (str/index-of allowed "The answer"))
          "once answered it is above the answer")
    (t/is (str/includes? (markup :denied) "penforge.chat.permission.denied"))))

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

(defn- ^:async with-mounted-overlay
  "Mount `ai-activity*` in a jsdom document with the store holding
  `state`, run `(test-fn container render)` and unmount. `render` renders
  the overlay again, as its viewport does, with `show-rulers`."
  [state test-fn]
  (let [dom          (JSDOM. "<!doctype html><html><body><div id='root'></div></body></html>")
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
      (let [root   (rdc/createRoot container)
            render (fn [show-rulers]
                     (react/act #(.render root (mf/element overlay/ai-activity* #js {:showRulers show-rulers}))))]
        (try
          (await (render true))
          (await (test-fn container render))
          (finally
            (await (react/act #(.unmount root))))))
      (finally
        (reset! st/state old-state)
        (restore-store! previous)
        (.close window)
        (set! (.-window js/globalThis) old-window)
        (set! (.-document js/globalThis) old-document)
        (set! (.-IS_REACT_ACT_ENVIRONMENT js/globalThis) old-act)))))

(defn- query-count
  [container selector]
  (.-length (.querySelectorAll container selector)))

(defn- glow
  [container]
  (.querySelector container "[data-testid='ai-activity']"))

(defn- inset
  [container]
  (.. (glow container) -style -inset))

(defn- update-state
  "Change the store inside `act`."
  [f & args]
  (react/act #(apply swap! st/state f args)))

(def ^:private root-shapes
  "Dozens of shapes directly on the page, as some models draw."
  (mapv #(cts/setup-shape {:type :rect :name "Card" :x (* 50 %) :y 0 :width 40 :height 20})
        (range 60)))

(defn- ai-commit
  "A local commit event as the AI's plugin makes it, adding `shape`."
  [shape]
  (ptk/reify ::dch/commit
    cljs.core/IDeref
    (-deref [_]
      {:source :local
       :redo-changes [{:type :add-obj :id (:id shape) :page-id page-id}]})))

(t/deftest ^:async one-glow-covers-the-canvas-and-leaves-with-the-run
  (await
   (with-mounted-overlay
     (workspace-state root-shapes #{} {:status :streaming})
     (^:async fn [container _render]
       (t/is (= 1 (query-count container "[data-testid='ai-activity']")))
       (t/is (= 1 (query-count container "[data-testid='ai-activity-badge']"))
             "one badge, however many shapes the page holds")
       (t/is (= "true" (.getAttribute (glow container) "aria-hidden")))

       (await (update-state assoc-in [:penforge :chat :status] :idle))
       (t/is (str/includes? (.-className (glow container)) "leaving")
             "the glow fades out when the run ends")

       (await (update-state assoc-in [:penforge :chat :status] :streaming))
       (t/is (not (str/includes? (.-className (glow container)) "leaving"))
             "new work during the fade shows it again")

       (await (update-state assoc-in [:penforge :chat :status] :idle))
       (await (react/act #(js/Promise. (fn [resolve]
                                         (js/setTimeout resolve (+ overlay/fade-out-ms 50))))))
       (t/is (nil? (glow container)) "and is gone afterwards")))))

(t/deftest ^:async the-glow-renders-once-whatever-happens-on-the-canvas
  (await
   (with-mounted-overlay
     (workspace-state root-shapes #{} {:status :streaming})
     (^:async fn [container render]
       (let [mutations (atom 0)
             observer  (new (.-MutationObserver js/window) #(swap! mutations + (alength %)))]
         (.observe observer container #js {:childList true
                                           :subtree true
                                           :attributes true
                                           :characterData true})
         (await (react/act #(st/emit! (ai-commit (first root-shapes)))))
         (await (update-state assoc-in [:files file-id :data :pages-index page-id :objects] {}))
         (await (update-state assoc-in [:workspace-local :zoom] 4))
         (await (update-state assoc-in [:workspace-local :vbox] {:x 900 :y 900 :width 10 :height 10}))
         (await (render true))
         (swap! mutations + (alength (.takeRecords observer)))
         (.disconnect observer)
         (t/is (= 0 @mutations)
               "commits, page objects, zoom and pan change nothing"))))))

(t/deftest ^:async the-glow-stays-off-the-rulers
  (await
   (with-mounted-overlay
     (workspace-state [] #{} {:status :streaming})
     (^:async fn [container render]
       (t/is (= "22px 0px 0px 22px" (inset container)))
       (await (render false))
       (t/is (= "0px" (inset container)) "without rulers it reaches the edges")))))

(t/deftest ^:async no-glow-without-ai-work
  (await
   (with-mounted-overlay
     (workspace-state root-shapes #{} {:runs {"run1" {:status :running :read-only true}}})
     (^:async fn [container _render]
       (await (react/act #(st/emit! (ai-commit (first root-shapes)))))
       (t/is (nil? (glow container))
             "the user's own edits and checks that only read never glow")

       (await (update-state assoc-in [:penforge :chat :runs "run2"] {:status :running :silent true}))
       (t/is (some? (glow container)) "a workflow run shows it")))))
