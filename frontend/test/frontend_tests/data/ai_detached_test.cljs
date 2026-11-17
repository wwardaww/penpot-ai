;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-detached-test
  "Detached AI chat window (W10): the lifecycle reducer, the window
  messages, and the components rendered into the sidebar, the
  detached window page and (from the workspace tab) the detached
  window document. Documents come from jsdom; the detached window is a
  second jsdom window, as a real popup is a second document."
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react" :as react]
   ["react-dom/client" :as rdc]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.detached :as detached]
   [app.main.store :as st]
   [app.main.ui.workspace.ai.chat.panel :as panel]
   [app.main.ui.workspace.ai.detached.page :as page]
   [app.main.ui.workspace.ai.detached.placeholder :as placeholder]
   [app.main.ui.workspace.ai.detached.window :as window]
   [app.util.globals :as globals]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [frontend-tests.helpers.mock :as mock]
   [rumext.v2 :as mf]))

;; --- Lifecycle reducer

(defn- reduce-events
  [events]
  (reductions (fn [state [event opts]]
                (detached/apply-window-event state event opts))
              nil
              events))

(t/deftest window-lifecycle
  (let [[docked opened ready unload ready-again closed]
        (reduce-events [[:opened {:window-name "w1"}]
                        [:ready]
                        [:unload]
                        [:ready]
                        [:closed]])]
    (t/is (nil? docked))
    (t/is (= {:status :opening :window-name "w1"} opened))
    (t/is (= {:status :open :window-name "w1"} ready))
    (t/is (= {:status :opening :window-name "w1"} unload) "a reload waits for the next ready")
    (t/is (= :open (:status ready-again)))
    (t/is (nil? closed) "closing docks the chat")))

(t/deftest late-window-events-keep-the-chat-docked
  (t/is (nil? (detached/apply-window-event nil :ready)))
  (t/is (nil? (detached/apply-window-event nil :unload))))

(t/deftest detached-reads-the-state
  (t/is (false? (detached/detached? {})))
  (t/is (true? (detached/detached? {:penforge {:detached {:status :opening}}}))))

(t/deftest window-names-are-unique
  (let [a (detached/new-window-name)
        b (detached/new-window-name)]
    (t/is (str/starts-with? a "penforge-chat-"))
    (t/is (not= a b))))

;; --- Window messages

(def ^:private origin "https://localhost:3449")

(defn- message-event
  [source data & {:keys [from] :or {from origin}}]
  #js {:source source :origin from :data data})

(t/deftest window-messages-are-parsed
  (let [popup #js {}]
    (t/is (= :ready (detached/parse-window-message
                     (message-event popup (detached/window-message :ready)) popup origin)))
    (t/is (= :unload (detached/parse-window-message
                      (message-event popup (detached/window-message :unload)) popup origin)))))

(t/deftest foreign-messages-are-ignored
  (let [popup #js {}
        ready (detached/window-message :ready)]
    (t/is (nil? (detached/parse-window-message (message-event #js {} ready) popup origin))
          "another window")
    (t/is (nil? (detached/parse-window-message
                 (message-event popup ready :from "https://evil.test") popup origin))
          "another origin")
    (t/is (nil? (detached/parse-window-message (message-event popup "ready") popup origin))
          "not our message shape")
    (t/is (nil? (detached/parse-window-message
                 (message-event popup #js {:type "other" :event "ready"}) popup origin))
          "another message type")
    (t/is (nil? (detached/parse-window-message
                 (message-event popup #js {:type detached/message-type :event "boom"}) popup origin))
          "unknown event")
    (t/is (nil? (detached/parse-window-message (message-event popup ready) nil origin))
          "no detached window")))

;; --- Rendering

(def ^:private chat-state
  {:penforge {:connection {:status :connected}
              :chat {:conversation-id "c1"
                     :status :idle
                     :entries [{:kind :user :id "u1" :text "Make the button blue"}]
                     :attachments []
                     :runs {}
                     :pending-runs {}}}})

(defn- app-store
  "The store the UI refs derive from. Another test namespace may leave
  `st/state` pointing at a stand-in atom, so it is taken from a ref."
  []
  (.-source ^js placeholder/ref:detached?))

(defn- ^:async with-dom
  "Install a jsdom window as the global one and `state` as the store
  state while `f` runs; resolves to what `f` resolves to."
  [state f]
  (let [dom          (JSDOM. "<!doctype html><html><body><div id='root'></div></body></html>")
        win          (.-window dom)
        old-window   (.-window js/globalThis)
        old-document (.-document js/globalThis)
        old-act      (.-IS_REACT_ACT_ENVIRONMENT js/globalThis)
        store        (app-store)
        old-state    @store
        result       (volatile! nil)]
    (set! (.-window js/globalThis) win)
    (set! (.-document js/globalThis) (.-document win))
    (set! (.-IS_REACT_ACT_ENVIRONMENT js/globalThis) true)
    (reset! store state)
    (try
      ;; DS tooltips create their portal container through `globals`.
      (await (mock/with-mocks* {globals/document (.-document win) globals/window win st/state store}
               (vreset! result (await (f win)))))
      @result
      (finally
        (reset! store old-state)
        (.close win)
        (set! (.-window js/globalThis) old-window)
        (set! (.-document js/globalThis) old-document)
        (set! (.-IS_REACT_ACT_ENVIRONMENT js/globalThis) old-act)))))

(defn- ^:async render-markup
  "Render `element` into the jsdom `win` and resolve to its markup."
  [^js win element]
  (let [container (.getElementById (.-document win) "root")
        root      (rdc/createRoot container)]
    (await (react/act #(.render root element)))
    (let [markup (.-innerHTML container)]
      (await (react/act #(.unmount root)))
      markup)))

(t/deftest ^:async sidebar-shows-the-chat-while-docked
  (let [markup (await (with-dom chat-state
                        #(render-markup % (mf/element panel/ai-chat-panel* #js {}))))]
    (t/is (str/includes? markup "ai-chat-panel"))
    (t/is (str/includes? markup "Make the button blue"))
    (t/is (str/includes? markup "ai-chat-detach") "the header offers to detach")
    (t/is (not (str/includes? markup "ai-chat-detached")))))

(t/deftest ^:async sidebar-shows-a-notice-while-detached
  (let [state  (assoc-in chat-state [:penforge :detached] {:status :open :window-name "w"})
        markup (await (with-dom state
                        #(render-markup % (mf/element panel/ai-chat-panel* #js {}))))]
    (t/is (str/includes? markup "ai-chat-detached"))
    (t/is (not (str/includes? markup "ai-chat-panel")) "the chat itself is in the other window")))

(t/deftest ^:async window-page-without-opener-explains-itself
  (let [markup (await (with-dom {}
                        #(render-markup % (mf/element page/detached-chat-page* #js {}))))]
    (t/is (str/includes? markup "ai-detached-page"))
    (t/is (str/includes? markup "penforge.detached.page.close")
          "an orphan window only offers to close itself")))

;; --- Pairing token

(defn- fake-storage
  [entries]
  (let [items (atom entries)]
    {:items items
     :storage #js {:removeItem #(swap! items dissoc %)}}))

(t/deftest pairing-token-key-matches-the-client
  (t/is (= client/token-key detached/pairing-token-key)))

(t/deftest the-window-drops-the-copied-pairing-token
  (let [{:keys [items storage]} (fake-storage {"penforge.token" "secret" "other" "kept"})]
    (detached/forget-pairing-token! storage)
    (t/is (= {"other" "kept"} @items)))
  (t/is (nil? (detached/forget-pairing-token! nil)) "no storage, nothing to do"))

(t/deftest ^:async the-window-page-drops-the-token-on-load
  (let [{:keys [items storage]} (fake-storage {"penforge.token" "secret"})
        previous (.-sessionStorage js/globalThis)]
    (set! (.-sessionStorage js/globalThis) storage)
    (try
      (await (with-dom {}
               #(render-markup % (mf/element page/detached-chat-page* #js {}))))
      (finally
        (set! (.-sessionStorage js/globalThis) previous)))
    (t/is (empty? @items))))

(t/deftest ^:async chat-renders-into-the-detached-window-document
  (let [state (assoc-in chat-state [:penforge :detached] {:status :open :window-name "w"})]
    (await
     (with-dom state
       (^:async fn [_]
         (let [popup (.-window (JSDOM. "<!doctype html><html><head></head><body></body></html>"))
               doc   (.-document popup)]
           (try
             (await (react/act #(window/mount! popup)))
             (let [container (.querySelector doc "[data-testid='ai-detached-chat']")
                   markup    (some-> container .-innerHTML)]
               (t/is (some? container) "the container lives in the detached document")
               (t/is (str/includes? markup "ai-chat-panel"))
               (t/is (str/includes? markup "Make the button blue"))
               (t/is (str/includes? markup "ai-chat-detach") "the header offers to dock"))

             ;; A state change of the workspace store reaches the
             ;; detached document with no sync step.
             (await (react/act
                     #(swap! (app-store) update-in [:penforge :chat :entries] conj
                             {:kind :assistant :id "a1" :text "Done, it is blue now"})))
             (t/is (str/includes? (.. doc -body -innerHTML) "Done, it is blue now"))

             ;; Mounting again (the window page reloaded) replaces the
             ;; first render.
             (await (react/act #(window/mount! popup)))
             (t/is (= 1 (.-length (.querySelectorAll doc "[data-testid='ai-detached-chat']"))))

             (await (react/act #(window/unmount!)))
             (t/is (nil? (.querySelector doc "[data-testid='ai-detached-chat']")))
             (finally
               (window/unmount!)
               (.close popup)))))))))
