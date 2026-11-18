;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.protocol
  "Penforge agent WebSocket protocol (`ws://127.0.0.1:4410/agent`).

  Mirrors `mcp/packages/common/src/agent-protocol.ts` (the source of
  truth) and `wiki/architecture.md` §5. Messages travel as JSON objects
  with camelCase keys; inside the app they are maps with kebab-case
  keyword keys and the `:type` as the protocol string (`\"chat.delta\"`).

  Key conversion is deep: payload maps sent to the daemon must use
  keyword keys for identifiers and string keys for anything that is not
  one (ids used as map keys), because keyword keys are camelCased."
  (:require
   [app.common.json :as json]
   [app.common.schema :as sm]
   [app.common.uuid :as uuid]))

;; --- Shared schemas

(def schema:persona
  [:enum "designer" "developer"])

(def schema:platform
  [:enum "web" "mobile"])

(def schema:node-attachment
  [:map {:title "NodeAttachment"}
   [:kind [:= "node"]]
   [:file-id :string]
   [:page-id :string]
   [:node-id :string]
   [:name :string]
   [:type :string]
   [:snapshot-png {:optional true} :string]])

(def schema:comment-attachment
  [:map {:title "CommentAttachment"}
   [:kind [:= "comment"]]
   [:thread-id :string]])

(def schema:image-attachment
  [:map {:title "ImageAttachment"}
   [:kind [:= "image"]]
   [:mime :string]
   [:base64 :string]])

(def schema:file-attachment
  "A file attached by the user (W25). `:base64` goes to the daemon;
  stored history entries carry the `:path` the daemon saved it at."
  [:map {:title "FileAttachment"}
   [:kind [:= "file"]]
   [:name :string]
   [:mime :string]
   [:size :int]
   [:base64 {:optional true} :string]
   [:path {:optional true} :string]])

(def schema:attachment
  [:multi {:dispatch :kind :title "Attachment"}
   ["node" schema:node-attachment]
   ["comment" schema:comment-attachment]
   ["image" schema:image-attachment]
   ["file" schema:file-attachment]])

(def file-limits
  "Limits of file attachments; mirror of `FILE_ATTACHMENT_LIMITS` in
  `agent-protocol.ts` (the daemon enforces them, the client checks
  first). Sizes in bytes, before base64 encoding."
  {:types {"image/png" :image
           "image/jpeg" :image
           "image/gif" :image
           "image/webp" :image
           "application/pdf" :pdf
           "text/plain" :text
           "text/markdown" :text
           "text/csv" :text
           "application/json" :text}
   :max-bytes {:image (* 5 1024 1024)
               :pdf (* 10 1024 1024)
               :text (* 1024 1024)}
   :max-files 10
   :max-total-bytes (* 20 1024 1024)})

;; --- Client -> daemon

(def schema:client-message
  [:multi {:dispatch :type :title "ClientMessage"}
   ["auth"
    [:map [:type :string] [:token :string]]]

   ["context.set"
    [:map
     [:type :string]
     [:file-id :string]
     [:file-name :string]
     [:project-id :string]
     [:team-id :string]
     [:page-id :string]
     [:persona schema:persona]
     [:platform schema:platform]
     [:mcp-session-id {:optional true} :string]
     [:project-name {:optional true} :string]]]

   ["chat.send"
    [:map
     [:type :string]
     [:rid :string]
     [:conversation-id :string]
     [:text :string]
     [:attachments {:optional true} [:vector schema:attachment]]]]

   ["chat.cancel"
    [:map [:type :string] [:conversation-id :string]]]

   ["chat.history"
    [:map [:type :string] [:rid :string] [:conversation-id :string]]]

   ["permission.respond"
    [:map
     [:type :string]
     [:request-id :string]
     [:allow :boolean]
     [:remember {:optional true} :boolean]]]

   ["workflow.run"
    [:map
     [:type :string]
     [:rid :string]
     [:name :string]
     [:params {:optional true} [:map-of :any :any]]]]

   ["workflow.cancel"
    [:map [:type :string] [:run-id :string]]]

   ["preview.start"
    [:map [:type :string] [:rid {:optional true} :string] [:project-id :string]]]

   ["preview.stop"
    [:map [:type :string] [:rid {:optional true} :string] [:project-id :string]]]])

;; --- Daemon -> client

(def schema:daemon-message
  [:multi {:dispatch :type :title "DaemonMessage"}
   ["auth.ok"
    [:map [:type :string] [:daemon-version :string]]]

   ["auth.error"
    [:map [:type :string] [:reason :string]]]

   ["chat.delta"
    [:map
     [:type :string]
     [:conversation-id :string]
     [:message-id :string]
     [:text :string]]]

   ["chat.tool"
    [:map
     [:type :string]
     [:conversation-id :string]
     [:tool-name :string]
     [:summary :string]
     [:status [:enum "running" "done" "error"]]
     [:detail {:optional true} :string]]]

   ["chat.done"
    [:map
     [:type :string]
     [:conversation-id :string]
     [:message-id :string]
     [:usage {:optional true} [:map-of :keyword :any]]]]

   ["chat.history"
    [:map
     [:type :string]
     [:rid :string]
     [:conversation-id :string]
     [:messages
      [:vector
       [:map
        [:role [:enum "user" "assistant"]]
        [:message-id :string]
        [:text :string]
        [:ts :string]
        [:attachments {:optional true} [:vector :any]]]]]]]

   ["permission.request"
    [:map
     [:type :string]
     [:request-id :string]
     [:title :string]
     [:description :string]
     [:risk [:enum "low" "medium" "high"]]]]

   ["workflow.started"
    [:map [:type :string] [:rid :string] [:run-id :string] [:name :string]]]

   ["workflow.event"
    [:map [:type :string] [:run-id :string] [:kind :string] [:payload {:optional true} :any]]]

   ["workflow.done"
    [:map
     [:type :string]
     [:run-id :string]
     [:ok :boolean]
     [:summary :string]
     [:error {:optional true} :string]]]

   ["preview.ready"
    [:map [:type :string] [:project-id :string] [:url :string]]]

   ["preview.stopped"
    [:map [:type :string] [:project-id :string] [:url {:optional true} :string]]]

   ["preview.status"
    [:map
     [:type :string]
     [:project-id :string]
     [:state [:enum "starting" "ready" "stopped" "failed"]]
     [:url {:optional true} :string]
     ;; unknown future reasons must not drop the message: a string
     [:reason {:optional true} :string]
     [:message {:optional true} :string]
     [:restarts {:optional true} :int]]]

   ["preview.log"
    [:map
     [:type :string]
     [:project-id :string]
     [:stream [:enum "stdout" "stderr" "system"]]
     [:text :string]]]

   ["error"
    [:map
     [:type :string]
     [:rid {:optional true} :string]
     [:code :string]
     [:message :string]]]])

(def valid-client-message?
  (sm/lazy-validator schema:client-message))

(def valid-daemon-message?
  (sm/lazy-validator schema:daemon-message))

(def check-client-message
  (sm/check-fn schema:client-message :hint "invalid penforge client message"))

(def error-codes
  "Error codes of the daemon `error` message."
  #{"bad-request" "not-authenticated" "no-context" "unknown-type"
    "unknown-workflow" "busy" "not-configured" "not-implemented" "internal"})

;; --- Encoding

(defn encode
  "Encode a client message map as a JSON string (camelCase keys)."
  [message]
  (json/encode message))

(defn decode
  "Decode a JSON string coming from the daemon. Returns the message map
  (kebab-case keyword keys) when it is a known, valid daemon message,
  otherwise nil."
  [data]
  (let [message (try
                  (json/decode data)
                  (catch :default _ nil))]
    (when (and (map? message)
               (valid-daemon-message? message))
      message)))

(defn next-rid
  "Return a new client request id."
  []
  (str (uuid/next)))

;; --- Client message constructors

(defn auth
  [token]
  {:type "auth" :token token})

(defn context-set
  [{:keys [file-id file-name project-id team-id page-id persona platform
           mcp-session-id project-name]}]
  (cond-> {:type "context.set"
           :file-id (str file-id)
           :file-name (or file-name "")
           :project-id (str project-id)
           :team-id (str team-id)
           :page-id (str page-id)
           :persona (name (or persona :designer))
           :platform (name (or platform :web))}
    (some? mcp-session-id)
    (assoc :mcp-session-id (str mcp-session-id))

    (some? project-name)
    (assoc :project-name project-name)))

(defn chat-send
  [{:keys [rid conversation-id text attachments]}]
  (cond-> {:type "chat.send"
           :rid (or rid (next-rid))
           :conversation-id conversation-id
           :text text}
    (seq attachments)
    (assoc :attachments (vec attachments))))

(defn chat-cancel
  [conversation-id]
  {:type "chat.cancel" :conversation-id conversation-id})

(defn chat-history
  [{:keys [rid conversation-id]}]
  {:type "chat.history"
   :rid (or rid (next-rid))
   :conversation-id conversation-id})

(defn permission-respond
  [{:keys [request-id allow remember]}]
  (cond-> {:type "permission.respond"
           :request-id request-id
           :allow (boolean allow)}
    (some? remember)
    (assoc :remember (boolean remember))))

(defn workflow-run
  [{:keys [rid name params]}]
  (cond-> {:type "workflow.run"
           :rid (or rid (next-rid))
           :name name}
    (some? params)
    (assoc :params params)))

(defn workflow-answer
  "The built-in `answer` workflow, which answers a workflow question."
  [{:keys [run-id question-id option-id]}]
  (workflow-run {:name "answer"
                 :params {:run-id run-id
                          :question-id question-id
                          :option-id option-id}}))

(defn workflow-cancel
  [run-id]
  {:type "workflow.cancel" :run-id run-id})

(defn preview-start
  ([project-id] (preview-start project-id nil))
  ([project-id rid]
   (cond-> {:type "preview.start" :project-id (str project-id)}
     (some? rid) (assoc :rid rid))))

(defn preview-stop
  ([project-id] (preview-stop project-id nil))
  ([project-id rid]
   (cond-> {:type "preview.stop" :project-id (str project-id)}
     (some? rid) (assoc :rid rid))))

(defn file-attachment
  "Build a file attachment."
  [{:keys [name mime size base64]}]
  {:kind "file"
   :name name
   :mime mime
   :size size
   :base64 base64})

(defn node-attachment
  "Build a node attachment from a shape."
  [file-id page-id shape]
  {:kind "node"
   :file-id (str file-id)
   :page-id (str page-id)
   :node-id (str (:id shape))
   :name (or (:name shape) "")
   :type (name (:type shape))})
