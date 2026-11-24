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
  [:enum "web" "mobile" "game" "existing"])

(def schema:linked-kind
  "Project types whose design works on a linked folder (W38)."
  [:enum "game" "existing"])

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

(def schema:folder-attachment
  "A folder attached by the user: every file in it is source material.
  `:base64` of each file goes to the daemon; stored history entries
  carry the folder's `:path` and the files without bytes."
  [:map {:title "FolderAttachment"}
   [:kind [:= "folder"]]
   [:name :string]
   [:files [:vector [:map
                     [:path :string]
                     [:size :int]
                     [:base64 {:optional true} :string]]]]
   [:path {:optional true} :string]])

(def schema:attachment
  [:multi {:dispatch :kind :title "Attachment"}
   ["node" schema:node-attachment]
   ["comment" schema:comment-attachment]
   ["image" schema:image-attachment]
   ["file" schema:file-attachment]
   ["folder" schema:folder-attachment]])

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
   :max-bytes {:image (* 3.75 1024 1024)
               :pdf (* 10 1024 1024)
               :text (* 1024 1024)}
   :max-files 10
   :max-total-bytes (* 20 1024 1024)})

(def folder-limits
  "Limits of folder attachments; mirror of `FOLDER_ATTACHMENT_LIMITS` in
  `agent-protocol.ts`. A folder's bytes count toward `file-limits`
  `:max-total-bytes`."
  {:max-files 300
   :max-file-bytes (* 10 1024 1024)
   :skipped #{".git" "node_modules" ".DS_Store" "Thumbs.db" "desktop.ini" "__MACOSX"}})

;; --- Client -> daemon

(def ^:private schema:output-pick
  "Folder pick of the output folder messages (W41)."
  [:map
   [:type :string]
   [:rid :string]
   [:project-id :string]
   [:purpose [:enum "build" "instruct"]]
   [:path :string]
   [:name {:optional true} :string]])

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
     [:attachments {:optional true} [:vector schema:attachment]]
     [:selection-dismissed {:optional true} :boolean]
     ;; W37: id of the user message, so it can be edited, deleted or reverted
     [:message-id {:optional true} :string]]]

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
    [:map [:type :string] [:rid {:optional true} :string] [:project-id :string]]]

   ;; W33: built apps on the dashboard (W39: `:app-id` names a
   ;; Re-Designed app)
   ["apps.list"
    [:map [:type :string] [:rid :string] [:team-id {:optional true} :string]]]

   ["apps.start"
    [:map [:type :string] [:rid :string] [:project-id :string]
     [:app-id {:optional true} :string]]]

   ["apps.stop"
    [:map [:type :string] [:rid :string] [:project-id :string]
     [:app-id {:optional true} :string]]]

   ["apps.logs"
    [:map [:type :string] [:rid :string] [:project-id :string]
     [:app-id {:optional true} :string]]]

   ["apps.phone.start"
    [:map [:type :string] [:rid :string] [:project-id :string]
     [:app-id {:optional true} :string] [:confirmed [:= true]]]]

   ["apps.phone.stop"
    [:map [:type :string] [:rid {:optional true} :string] [:project-id :string]
     [:app-id {:optional true} :string]]]

   ;; W37: message actions in the chat
   ["chat.edit"
    [:map
     [:type :string]
     [:rid :string]
     [:conversation-id :string]
     [:message-id :string]
     [:text :string]
     [:new-message-id {:optional true} :string]
     [:selection-dismissed {:optional true} :boolean]]]

   ["chat.delete"
    [:map [:type :string] [:rid :string] [:conversation-id :string] [:message-id :string]]]

   ["chat.revert"
    [:map
     [:type :string]
     [:rid :string]
     [:conversation-id :string]
     [:message-id :string]
     [:confirmed [:= true]]]]

   ;; W38: daemon folder browser and linked project folders
   ["folder.list"
    [:map [:type :string] [:rid :string] [:path {:optional true} :string]]]

   ["project.link"
    [:map
     [:type :string]
     [:rid :string]
     [:project-id :string]
     [:kind schema:linked-kind]
     [:path :string]]]

   ["project.link.status"
    [:map [:type :string] [:rid :string] [:project-id :string]]]

   ;; the font files of a linked project, for the import into the team
   ["fonts.files"
    [:map [:type :string] [:rid :string] [:project-id :string]]]

   ;; W41: output folder of web and mobile projects
   ["project.output.status"
    [:map [:type :string] [:rid :string] [:project-id :string]]]

   ["project.output.preview" schema:output-pick]

   ["project.output.set" schema:output-pick]])

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
     [:detail {:optional true} :string]
     ;; daemon checks (W25): stable code + params the client words itself
     [:code {:optional true} :string]
     [:params {:optional true} [:map-of :keyword :any]]]]

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

   ["permission.closed"
    [:map [:type :string] [:request-id :string]]]

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

   ;; W33: built apps on the dashboard (items checked by app.main.data.ai.apps)
   ["apps.list"
    [:map [:type :string] [:rid :string] [:apps [:vector :any]]]]

   ["apps.status"
    [:map
     [:type :string]
     [:project-id :string]
     [:app-id {:optional true} :string]
     [:state :string]
     [:url {:optional true} :string]
     [:reason {:optional true} :string]
     [:message {:optional true} :string]
     [:exposure {:optional true} :string]]]

   ["apps.logs"
    [:map [:type :string] [:rid :string] [:project-id :string]
     [:app-id {:optional true} :string] [:lines [:vector :any]]]]

   ["apps.phone"
    [:map
     [:type :string]
     [:project-id :string]
     [:app-id {:optional true} :string]
     [:state :string]
     [:url {:optional true} :string]
     [:host {:optional true} :string]
     [:port {:optional true} :int]
     [:qr {:optional true} [:map [:size :int] [:rows [:vector :string]]]]
     [:expires-at {:optional true} :string]
     [:code {:optional true} :string]
     [:message {:optional true} :string]]]

   ;; W37: reply to chat.edit / chat.delete / chat.revert
   ["chat.changed"
    [:map
     [:type :string]
     [:rid :string]
     [:conversation-id :string]
     [:action [:enum "edit" "delete" "revert"]]
     [:message-id :string]
     [:removed [:vector :string]]
     [:design {:optional true} [:enum "restored" "unchanged"]]
     [:checkpoint-id {:optional true} :string]]]

   ;; W38: folder browser listing and linked folder state (entries and
   ;; facts are checked by app.main.data.ai.linked)
   ["folder.list"
    [:map
     [:type :string]
     [:rid :string]
     [:path [:maybe :string]]
     [:parent {:optional true} [:maybe :string]]
     [:roots {:optional true} [:vector :any]]
     [:entries [:vector :any]]
     [:truncated {:optional true} :boolean]
     [:facts {:optional true} [:maybe [:map-of :keyword :any]]]]]

   ["project.linked"
    [:map
     [:type :string]
     [:rid :string]
     [:project-id :string]
     [:linked :boolean]
     [:kind {:optional true} :string]
     [:linked-root {:optional true} :string]
     [:engine {:optional true} [:maybe :string]]
     [:stack {:optional true} [:maybe [:map-of :keyword :any]]]]]

   ;; reply to fonts.files (each file `{:name :data}`, data in base64)
   ["fonts.files"
    [:map
     [:type :string]
     [:rid :string]
     [:project-id :string]
     [:files [:vector [:map [:name :string] [:data :string]]]]
     [:google [:vector :string]]]]

   ;; W41: output folder (reply to the project.output requests)
   ["project.output"
    [:map
     [:type :string]
     [:rid :string]
     [:project-id :string]
     [:app [:map [:state :string] [:path [:maybe :string]] [:built :boolean]]]
     [:output [:map [:state :string] [:path [:maybe :string]]]]
     [:target {:optional true}
      [:map
       [:picked :string]
       [:path :string]
       [:sub-folder :boolean]
       [:existing :boolean]]]]]

   ;; a design tool found no MCP plugin session for this tab: restart
   ;; the hidden plugin
   ["mcp.restart"
    [:map [:type :string]]]

   ["error"
    [:map
     [:type :string]
     [:rid {:optional true} :string]
     [:code :string]
     [:message :string]
     ;; finer reason of a refused request (W25 file refusals) and its params
     [:reason {:optional true} :string]
     [:params {:optional true} [:map-of :keyword :any]]]]])

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
  [{:keys [rid conversation-id text attachments selection-dismissed message-id]}]
  (cond-> {:type "chat.send"
           :rid (or rid (next-rid))
           :conversation-id conversation-id
           :text text}
    (seq attachments)
    (assoc :attachments (vec attachments))

    selection-dismissed
    (assoc :selection-dismissed true)

    (some? message-id)
    (assoc :message-id message-id)))

(defn chat-edit
  "Send the user message `message-id` again with `text` (W37); the daemon
  drops it and every later message first."
  [{:keys [rid conversation-id message-id text new-message-id selection-dismissed]}]
  (cond-> {:type "chat.edit"
           :rid (or rid (next-rid))
           :conversation-id conversation-id
           :message-id message-id
           :text text}
    (some? new-message-id)
    (assoc :new-message-id new-message-id)

    selection-dismissed
    (assoc :selection-dismissed true)))

(defn chat-delete
  "Drop the user message `message-id` and its answer (W37)."
  [{:keys [rid conversation-id message-id]}]
  {:type "chat.delete"
   :rid (or rid (next-rid))
   :conversation-id conversation-id
   :message-id message-id})

(defn chat-revert
  "Put the design back to before the user message `message-id` and drop
  it and every later message (W37). Send it only after the user said yes."
  [{:keys [rid conversation-id message-id]}]
  {:type "chat.revert"
   :rid (or rid (next-rid))
   :conversation-id conversation-id
   :message-id message-id
   :confirmed true})

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

;; W38: folder browser and linked folders

(defn folder-list
  [{:keys [rid path]}]
  (cond-> {:type "folder.list"
           :rid (or rid (next-rid))}
    (string? path)
    (assoc :path path)))

(defn project-link
  [{:keys [rid project-id kind path]}]
  {:type "project.link"
   :rid (or rid (next-rid))
   :project-id (str project-id)
   :kind (name kind)
   :path path})

(defn project-link-status
  [{:keys [rid project-id]}]
  {:type "project.link.status"
   :rid (or rid (next-rid))
   :project-id (str project-id)})

;; W41: output folder

(defn project-output-status
  [{:keys [rid project-id]}]
  {:type "project.output.status"
   :rid (or rid (next-rid))
   :project-id (str project-id)})

(defn- output-pick
  [type {:keys [rid project-id purpose path name]}]
  (cond-> {:type type
           :rid (or rid (next-rid))
           :project-id (str project-id)
           :purpose (cljs.core/name purpose)
           :path path}
    (string? name)
    (assoc :name name)))

(defn project-output-preview
  "Which folder Build or Instruct (`purpose`) would use for `path`."
  [params]
  (output-pick "project.output.preview" params))

(defn project-output-set
  "Use the folder that `path` gives."
  [params]
  (output-pick "project.output.set" params))

(defn fonts-files
  [{:keys [rid project-id]}]
  {:type "fonts.files"
   :rid (or rid (next-rid))
   :project-id (str project-id)})

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

(defn folder-attachment
  "Build a folder attachment from its name and files (`:path`, `:size`,
  `:base64`)."
  [name files]
  {:kind "folder"
   :name name
   :files (mapv #(select-keys % [:path :size :base64]) files)})

(defn node-attachment
  "Build a node attachment from a shape."
  [file-id page-id shape]
  {:kind "node"
   :file-id (str file-id)
   :page-id (str page-id)
   :node-id (str (:id shape))
   :name (or (:name shape) "")
   :type (name (:type shape))})
