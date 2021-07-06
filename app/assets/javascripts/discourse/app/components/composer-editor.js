import {
  authorizedExtensions,
  authorizesAllExtensions,
  authorizesOneOrMoreImageExtensions,
  displayErrorForUpload,
  getUploadMarkdown,
  validateUploadedFiles,
} from "discourse/lib/uploads";
import {
  cacheShortUploadUrl,
  resolveAllShortUrls,
} from "pretty-text/upload-short-url";
import {
  caretPosition,
  clipboardHelpers,
  formatUsername,
  inCodeBlock,
  tinyAvatar,
} from "discourse/lib/utilities";
import discourseComputed, {
  observes,
  on,
} from "discourse-common/utils/decorators";
import {
  fetchUnseenHashtags,
  linkSeenHashtags,
} from "discourse/lib/link-hashtags";
import {
  fetchUnseenMentions,
  linkSeenMentions,
} from "discourse/lib/link-mentions";
import { later, next, run, schedule, throttle } from "@ember/runloop";
import Component from "@ember/component";
import Composer from "discourse/models/composer";
import EmberObject from "@ember/object";
import Uppy, { AwsS3, XHRUpload } from "uppy";
import I18n from "I18n";
import { ajax } from "discourse/lib/ajax";
import bootbox from "bootbox";
import discourseDebounce from "discourse-common/lib/debounce";
import { findRawTemplate } from "discourse-common/lib/raw-templates";
import getURL from "discourse-common/lib/get-url";
import { iconHTML } from "discourse-common/lib/icon-library";
import { isTesting } from "discourse-common/config/environment";
import { loadOneboxes } from "discourse/lib/load-oneboxes";
import putCursorAtEnd from "discourse/lib/put-cursor-at-end";
import userSearch from "discourse/lib/user-search";

const REBUILD_SCROLL_MAP_EVENTS = ["composer:resized", "composer:typed-reply"];

let uploadHandlers = [];
export function addComposerUploadHandler(extensions, method) {
  uploadHandlers.push({
    extensions,
    method,
  });
}
export function cleanUpComposerUploadHandler() {
  uploadHandlers = [];
}

let uploadProcessorQueue = [];
let uploadProcessorActions = {};
export function addComposerUploadProcessor(queueItem, actionItem) {
  uploadProcessorQueue.push(queueItem);
  Object.assign(uploadProcessorActions, actionItem);
}
export function cleanUpComposerUploadProcessor() {
  uploadProcessorQueue = [];
  uploadProcessorActions = {};
}

let uploadMarkdownResolvers = [];
export function addComposerUploadMarkdownResolver(resolver) {
  uploadMarkdownResolvers.push(resolver);
}
export function cleanUpComposerUploadMarkdownResolver() {
  uploadMarkdownResolvers = [];
}

export default Component.extend({
  classNameBindings: ["showToolbar:toolbar-visible", ":wmd-controls"],

  uploadProgress: 0,
  _xhr: null,
  shouldBuildScrollMap: true,
  scrollMap: null,
  uploadFilenamePlaceholder: null,

  @discourseComputed("uploadFilenamePlaceholder")
  uploadPlaceholder(uploadFilenamePlaceholder) {
    const clipboard = I18n.t("clipboard");
    const filename = uploadFilenamePlaceholder
      ? uploadFilenamePlaceholder
      : clipboard;

    let placeholder = `[${I18n.t("uploading_filename", { filename })}]()\n`;
    if (!this._cursorIsOnEmptyLine()) {
      placeholder = `\n${placeholder}`;
    }

    return placeholder;
  },

  @discourseComputed("composer.requiredCategoryMissing")
  replyPlaceholder(requiredCategoryMissing) {
    if (requiredCategoryMissing) {
      return "composer.reply_placeholder_choose_category";
    } else {
      const key = authorizesOneOrMoreImageExtensions(
        this.currentUser.staff,
        this.siteSettings
      )
        ? "reply_placeholder"
        : "reply_placeholder_no_images";
      return `composer.${key}`;
    }
  },

  @discourseComputed
  showLink() {
    return (
      this.currentUser && this.currentUser.get("link_posting_access") !== "none"
    );
  },

  @discourseComputed("composer.requiredCategoryMissing", "composer.replyLength")
  disableTextarea(requiredCategoryMissing, replyLength) {
    return requiredCategoryMissing && replyLength === 0;
  },

  @observes("composer.uploadCancelled")
  _cancelUpload() {
    if (!this.get("composer.uploadCancelled")) {
      return;
    }
    this.set("composer.uploadCancelled", false);

    if (this._xhr) {
      this._xhr._userCancelled = true;
      this._xhr.abort();
    }
    this._resetUpload(true);
  },

  @observes("focusTarget")
  setFocus() {
    if (this.focusTarget === "editor") {
      putCursorAtEnd(this.element.querySelector("textarea"));
    }
  },

  @discourseComputed
  markdownOptions() {
    return {
      previewing: true,

      formatUsername,

      lookupAvatarByPostNumber: (postNumber, topicId) => {
        const topic = this.topic;
        if (!topic) {
          return;
        }

        const posts = topic.get("postStream.posts");
        if (posts && topicId === topic.get("id")) {
          const quotedPost = posts.findBy("post_number", postNumber);
          if (quotedPost) {
            return tinyAvatar(quotedPost.get("avatar_template"));
          }
        }
      },

      lookupPrimaryUserGroupByPostNumber: (postNumber, topicId) => {
        const topic = this.topic;
        if (!topic) {
          return;
        }

        const posts = topic.get("postStream.posts");
        if (posts && topicId === topic.get("id")) {
          const quotedPost = posts.findBy("post_number", postNumber);
          if (quotedPost) {
            return quotedPost.primary_group_name;
          }
        }
      },
    };
  },

  userSearchTerm(term) {
    const topicId = this.get("topic.id");
    // maybe this is a brand new topic, so grab category from composer
    const categoryId =
      this.get("topic.category_id") || this.get("composer.categoryId");

    return userSearch({
      term,
      topicId,
      categoryId,
      includeGroups: true,
    });
  },

  @discourseComputed()
  acceptsAllFormats() {
    return authorizesAllExtensions(this.currentUser.staff, this.siteSettings);
  },

  @discourseComputed()
  acceptedFormats() {
    const extensions = authorizedExtensions(
      this.currentUser.staff,
      this.siteSettings
    );

    return extensions.map((ext) => `.${ext}`).join();
  },

  @on("didInsertElement")
  _composerEditorInit() {
    const $input = $(this.element.querySelector(".d-editor-input"));
    const $preview = $(this.element.querySelector(".d-editor-preview-wrapper"));

    if (this.siteSettings.enable_mentions) {
      $input.autocomplete({
        template: findRawTemplate("user-selector-autocomplete"),
        dataSource: (term) => this.userSearchTerm.call(this, term),
        key: "@",
        transformComplete: (v) => v.username || v.name,
        afterComplete: (value) => {
          this.composer.set("reply", value);

          // ensures textarea scroll position is correct
          schedule("afterRender", () => $input.blur().focus());
        },
        triggerRule: (textarea) =>
          !inCodeBlock(textarea.value, caretPosition(textarea)),
      });
    }

    if (this._enableAdvancedEditorPreviewSync()) {
      this._initInputPreviewSync($input, $preview);
    } else {
      $input.on("scroll", () =>
        throttle(this, this._syncEditorAndPreviewScroll, $input, $preview, 20)
      );
    }

    // Focus on the body unless we have a title
    if (!this.get("composer.canEditTitle")) {
      putCursorAtEnd(this.element.querySelector(".d-editor-input"));
    }

    this._bindUploadTarget();
    this._bindUppyUploadTarget();
    this.appEvents.trigger("composer:will-open");
  },

  @discourseComputed(
    "composer.reply",
    "composer.replyLength",
    "composer.missingReplyCharacters",
    "composer.minimumPostLength",
    "lastValidatedAt"
  )
  validation(
    reply,
    replyLength,
    missingReplyCharacters,
    minimumPostLength,
    lastValidatedAt
  ) {
    const postType = this.get("composer.post.post_type");
    if (postType === this.site.get("post_types.small_action")) {
      return;
    }

    let reason;
    if (replyLength < 1) {
      reason = I18n.t("composer.error.post_missing");
    } else if (missingReplyCharacters > 0) {
      reason = I18n.t("composer.error.post_length", {
        count: minimumPostLength,
      });
      const tl = this.get("currentUser.trust_level");
      if (tl === 0 || tl === 1) {
        reason +=
          "<br/>" +
          I18n.t("composer.error.try_like", {
            heart: iconHTML("heart", {
              label: I18n.t("likes_lowercase", { count: 1 }),
            }),
          });
      }
    }

    if (reason) {
      return EmberObject.create({
        failed: true,
        reason,
        lastShownAt: lastValidatedAt,
      });
    }
  },

  _setUploadPlaceholderSend(data) {
    const filename = this._filenamePlaceholder(data);
    this.set("uploadFilenamePlaceholder", filename);

    // when adding two separate files with the same filename search for matching
    // placeholder already existing in the editor ie [Uploading: test.png...]
    // and add order nr to the next one: [Uploading: test.png(1)...]
    const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regexString = `\\[${I18n.t("uploading_filename", {
      filename: escapedFilename + "(?:\\()?([0-9])?(?:\\))?",
    })}\\]\\(\\)`;
    const globalRegex = new RegExp(regexString, "g");
    const matchingPlaceholder = this.get("composer.reply").match(globalRegex);
    if (matchingPlaceholder) {
      // get last matching placeholder and its consecutive nr in regex
      // capturing group and apply +1 to the placeholder
      const lastMatch = matchingPlaceholder[matchingPlaceholder.length - 1];
      const regex = new RegExp(regexString);
      const orderNr = regex.exec(lastMatch)[1]
        ? parseInt(regex.exec(lastMatch)[1], 10) + 1
        : 1;
      data.orderNr = orderNr;
      const filenameWithOrderNr = `${filename}(${orderNr})`;
      this.set("uploadFilenamePlaceholder", filenameWithOrderNr);
    }
  },

  _setUploadPlaceholderDone(data) {
    const filename = this._filenamePlaceholder(data);
    const filenameWithSize = `${filename} (${data.total})`;
    this.set("uploadFilenamePlaceholder", filenameWithSize);

    if (data.orderNr) {
      const filenameWithOrderNr = `${filename}(${data.orderNr})`;
      this.set("uploadFilenamePlaceholder", filenameWithOrderNr);
    } else {
      this.set("uploadFilenamePlaceholder", filename);
    }
  },

  _filenamePlaceholder(data) {
    return data.files[0].name.replace(/\u200B-\u200D\uFEFF]/g, "");
  },

  _resetUploadFilenamePlaceholder() {
    this.set("uploadFilenamePlaceholder", null);
  },

  _enableAdvancedEditorPreviewSync() {
    return this.siteSettings.enable_advanced_editor_preview_sync;
  },

  _resetShouldBuildScrollMap() {
    this.set("shouldBuildScrollMap", true);
  },

  _initInputPreviewSync($input, $preview) {
    REBUILD_SCROLL_MAP_EVENTS.forEach((event) => {
      this.appEvents.on(event, this, this._resetShouldBuildScrollMap);
    });

    schedule("afterRender", () => {
      $input.on("touchstart mouseenter", () => {
        if (!$preview.is(":visible")) {
          return;
        }
        $preview.off("scroll");

        $input.on("scroll", () => {
          this._syncScroll(this._syncEditorAndPreviewScroll, $input, $preview);
        });
      });

      $preview.on("touchstart mouseenter", () => {
        $input.off("scroll");

        $preview.on("scroll", () => {
          this._syncScroll(this._syncPreviewAndEditorScroll, $input, $preview);
        });
      });
    });
  },

  _syncScroll($callback, $input, $preview) {
    if (!this.scrollMap || this.shouldBuildScrollMap) {
      this.set("scrollMap", this._buildScrollMap($input, $preview));
      this.set("shouldBuildScrollMap", false);
    }

    throttle(this, $callback, $input, $preview, this.scrollMap, 20);
  },

  _teardownInputPreviewSync() {
    [
      $(this.element.querySelector(".d-editor-input")),
      $(this.element.querySelector(".d-editor-preview-wrapper")),
    ].forEach(($element) => {
      $element.off("mouseenter touchstart");
      $element.off("scroll");
    });

    REBUILD_SCROLL_MAP_EVENTS.forEach((event) => {
      this.appEvents.off(event, this, this._resetShouldBuildScrollMap);
    });
  },

  // Adapted from https://github.com/markdown-it/markdown-it.github.io
  _buildScrollMap($input, $preview) {
    let sourceLikeDiv = $("<div />")
      .css({
        position: "absolute",
        height: "auto",
        visibility: "hidden",
        width: $input[0].clientWidth,
        "font-size": $input.css("font-size"),
        "font-family": $input.css("font-family"),
        "line-height": $input.css("line-height"),
        "white-space": $input.css("white-space"),
      })
      .appendTo("body");

    const linesMap = [];
    let numberOfLines = 0;

    $input
      .val()
      .split("\n")
      .forEach((text) => {
        linesMap.push(numberOfLines);

        if (text.length === 0) {
          numberOfLines++;
        } else {
          sourceLikeDiv.text(text);

          let height;
          let lineHeight;
          height = parseFloat(sourceLikeDiv.css("height"));
          lineHeight = parseFloat(sourceLikeDiv.css("line-height"));
          numberOfLines += Math.round(height / lineHeight);
        }
      });

    linesMap.push(numberOfLines);
    sourceLikeDiv.remove();

    const previewOffsetTop = $preview.offset().top;
    const offset =
      $preview.scrollTop() -
      previewOffsetTop -
      ($input.offset().top - previewOffsetTop);
    const nonEmptyList = [];
    const scrollMap = [];
    for (let i = 0; i < numberOfLines; i++) {
      scrollMap.push(-1);
    }

    nonEmptyList.push(0);
    scrollMap[0] = 0;

    $preview.find(".preview-sync-line").each((_, element) => {
      let $element = $(element);
      let lineNumber = $element.data("line-number");
      let linesToTop = linesMap[lineNumber];
      if (linesToTop !== 0) {
        nonEmptyList.push(linesToTop);
      }
      scrollMap[linesToTop] = Math.round($element.offset().top + offset);
    });

    nonEmptyList.push(numberOfLines);
    scrollMap[numberOfLines] = $preview[0].scrollHeight;

    let position = 0;

    for (let i = 1; i < numberOfLines; i++) {
      if (scrollMap[i] !== -1) {
        position++;
        continue;
      }

      let top = nonEmptyList[position];
      let bottom = nonEmptyList[position + 1];

      scrollMap[i] = (
        (scrollMap[bottom] * (i - top) + scrollMap[top] * (bottom - i)) /
        (bottom - top)
      ).toFixed(2);
    }

    return scrollMap;
  },

  _syncEditorAndPreviewScroll($input, $preview, scrollMap) {
    if (this._enableAdvancedEditorPreviewSync()) {
      let scrollTop;
      const inputHeight = $input.height();
      const inputScrollHeight = $input[0].scrollHeight;
      const inputClientHeight = $input[0].clientHeight;
      const scrollable = inputScrollHeight > inputClientHeight;

      if (
        scrollable &&
        inputHeight + $input.scrollTop() + 100 > inputScrollHeight
      ) {
        scrollTop = $preview[0].scrollHeight;
      } else {
        const lineHeight = parseFloat($input.css("line-height"));
        const lineNumber = Math.floor($input.scrollTop() / lineHeight);
        scrollTop = scrollMap[lineNumber];
      }

      $preview.stop(true).animate({ scrollTop }, 100, "linear");
    } else {
      if (!$input) {
        return;
      }

      if ($input.scrollTop() === 0) {
        $preview.scrollTop(0);
        return;
      }

      const inputHeight = $input[0].scrollHeight;
      const previewHeight = $preview[0].scrollHeight;

      if ($input.height() + $input.scrollTop() + 100 > inputHeight) {
        // cheat, special case for bottom
        $preview.scrollTop(previewHeight);
        return;
      }

      const scrollPosition = $input.scrollTop();
      const factor = previewHeight / inputHeight;
      const desired = scrollPosition * factor;
      $preview.scrollTop(desired + 50);
    }
  },

  _syncPreviewAndEditorScroll($input, $preview, scrollMap) {
    if (scrollMap.length < 1) {
      return;
    }

    let scrollTop;
    const previewScrollTop = $preview.scrollTop();

    if ($preview.height() + previewScrollTop + 100 > $preview[0].scrollHeight) {
      scrollTop = $input[0].scrollHeight;
    } else {
      const lineHeight = parseFloat($input.css("line-height"));
      scrollTop =
        lineHeight * scrollMap.findIndex((offset) => offset > previewScrollTop);
    }

    $input.stop(true).animate({ scrollTop }, 100, "linear");
  },

  _renderUnseenMentions($preview, unseen) {
    // 'Create a New Topic' scenario is not supported (per conversation with codinghorror)
    // https://meta.discourse.org/t/taking-another-1-7-release-task/51986/7
    fetchUnseenMentions(unseen, this.get("composer.topic.id")).then(() => {
      linkSeenMentions($preview, this.siteSettings);
      this._warnMentionedGroups($preview);
      this._warnCannotSeeMention($preview);
    });
  },

  _renderUnseenHashtags($preview) {
    const unseen = linkSeenHashtags($preview);
    if (unseen.length > 0) {
      fetchUnseenHashtags(unseen).then(() => {
        linkSeenHashtags($preview);
      });
    }
  },

  _warnMentionedGroups($preview) {
    schedule("afterRender", () => {
      let found = this.warnedGroupMentions || [];
      $preview.find(".mention-group.notify").each((idx, e) => {
        if (this._isInQuote(e)) {
          return;
        }

        const $e = $(e);
        let name = $e.data("name");
        if (found.indexOf(name) === -1) {
          this.groupsMentioned([
            {
              name: name,
              user_count: $e.data("mentionable-user-count"),
              max_mentions: $e.data("max-mentions"),
            },
          ]);
          found.push(name);
        }
      });

      this.set("warnedGroupMentions", found);
    });
  },

  _warnCannotSeeMention($preview) {
    const composerDraftKey = this.get("composer.draftKey");

    if (composerDraftKey === Composer.NEW_PRIVATE_MESSAGE_KEY) {
      return;
    }

    schedule("afterRender", () => {
      let found = this.warnedCannotSeeMentions || [];

      $preview.find(".mention.cannot-see").each((idx, e) => {
        const $e = $(e);
        let name = $e.data("name");

        if (found.indexOf(name) === -1) {
          // add a delay to allow for typing, so you don't open the warning right away
          // previously we would warn after @bob even if you were about to mention @bob2
          later(
            this,
            () => {
              if (
                $preview.find('.mention.cannot-see[data-name="' + name + '"]')
                  .length > 0
              ) {
                this.cannotSeeMention([{ name }]);
                found.push(name);
              }
            },
            2000
          );
        }
      });

      this.set("warnedCannotSeeMentions", found);
    });
  },

  _resetUpload(removePlaceholder) {
    next(() => {
      if (this._validUploads > 0) {
        this._validUploads--;
      }
      if (this._validUploads === 0) {
        this.setProperties({
          uploadProgress: 0,
          isUploading: false,
          isProcessingUpload: false,
          isCancellable: false,
        });
      }
      if (removePlaceholder) {
        this.appEvents.trigger(
          "composer:replace-text",
          this.uploadPlaceholder,
          ""
        );
      }
      this._resetUploadFilenamePlaceholder();
    });
  },

  _csrfToken() {
    return document.querySelector("meta[name='csrf-token']").content;
  },

  _bindUppyUploadTarget() {
    const uppy = new Uppy({ autoProceed: true });
    let useXhr = false;

    if (useXhr) {
      uppy.use(XHRUpload, {
        endpoint: getURL(`/uploads.json?client_id=${this.messageBus.clientId}`),
        headers: {
          "X-CSRF-Token": this._csrfToken(),
        },
      });
    } else {
      uppy.use(AwsS3, {
        getUploadParameters(file) {
          return fetch("/uploads/generate-presigned", {
            method: "post",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "X-CSRF-Token": this._csrfToken(),
            },
            body: JSON.stringify({
              filename: file.name,
              contentType: file.type,
            }),
          })
            .then((response) => {
              // Parse the JSON response.
              return response.json();
            })
            .then((data) => {
              // Return an object in the correct shape.
              return {
                method: data.method,
                url: data.url,
                // Provide content type header required by S3
                headers: {
                  "Content-Type": file.type,
                },
              };
            });
        },
      });
    }

    uppy.on("upload", (data) => {
      const files = data.fileIDs.map((fileId) => uppy.getFile(fileId));
      const opts = {
        user: this.currentUser,
        siteSettings: this.siteSettings,
        isPrivateMessage: false,
        allowStaffToUploadAnyFileInPm: this.siteSettings
          .allow_staff_to_upload_any_file_in_pm,
      };

      files.forEach((file) => {
        const isUploading = validateUploadedFiles([file], opts);
        this.setProperties({ uploadProgress: 0, isUploading });
        let fileData = { files: [file] };
        this._setUploadPlaceholderSend(fileData);
        this.appEvents.trigger("composer:insert-text", this.uploadPlaceholder);
      });
    });

    uppy.on("upload-success", (file, response) => {
      let upload = response.body;
      this._setUploadPlaceholderDone({ files: [file] });
      const markdown = uploadMarkdownResolvers.reduce(
        (md, resolver) => resolver(upload) || md,
        getUploadMarkdown(upload)
      );

      cacheShortUploadUrl(upload.short_url, upload);
      this.appEvents.trigger(
        "composer:replace-text",
        this.uploadPlaceholder.trim(),
        markdown
      );
    });

    uppy.on("progress", (progress) => {
      // eslint-disable-next-line no-console
      console.log(progress);
      this.set("uploadProgress", progress);
    });

    const fileInput = document.getElementById("file-uploader-uppy");

    fileInput.addEventListener("change", (event) => {
      const files = Array.from(event.target.files);

      files.forEach((file) => {
        try {
          uppy.addFile({
            source: "file input",
            name: file.name,
            type: file.type,
            data: file,
          });
        } catch (err) {
          if (err.isRestriction) {
            // handle restrictions
            // eslint-disable-next-line no-console
            console.log("Restriction error:", err);
          } else {
            // handle other errors
            // eslint-disable-next-line no-console
            console.error(err);
          }
        }
      });
    });

    uppy.on("file-removed", () => {
      fileInput.value = null;
      this._resetUpload(true);
    });

    uppy.on("complete", () => {
      fileInput.value = null;
      this._resetUpload(false);
    });
  },

  _bindUploadTarget() {
    this._unbindUploadTarget(); // in case it's still bound, let's clean it up first
    this._pasted = false;

    const $element = $(this.element);
    $.blueimp.fileupload.prototype.processActions = uploadProcessorActions;

    $element.fileupload({
      url: getURL(`/uploads.json?client_id=${this.messageBus.clientId}`),
      dataType: "json",
      pasteZone: $element,
      processQueue: uploadProcessorQueue,
    });

    $element
      .on("fileuploadprocess", (e, data) => {
        this.appEvents.trigger(
          "composer:insert-text",
          `[${I18n.t("processing_filename", {
            filename: data.files[data.index].name,
          })}]()\n`
        );
        this.setProperties({
          uploadProgress: 0,
          isUploading: true,
          isProcessingUpload: true,
          isCancellable: false,
        });
      })
      .on("fileuploadprocessalways", (e, data) => {
        this.appEvents.trigger(
          "composer:replace-text",
          `[${I18n.t("processing_filename", {
            filename: data.files[data.index].name,
          })}]()\n`,
          ""
        );
        this.setProperties({
          uploadProgress: 0,
          isUploading: false,
          isProcessingUpload: false,
          isCancellable: false,
        });
      });

    $element.on("fileuploadpaste", (e) => {
      this._pasted = true;

      if (!$(".d-editor-input").is(":focus")) {
        return;
      }

      const { canUpload, canPasteHtml, types } = clipboardHelpers(e, {
        siteSettings: this.siteSettings,
        canUpload: true,
      });

      if (!canUpload || canPasteHtml || types.includes("text/plain")) {
        e.preventDefault();
      }
    });

    $element.on("fileuploadsubmit", (e, data) => {
      const max = this.siteSettings.simultaneous_uploads;

      // Limit the number of simultaneous uploads
      if (max > 0 && data.files.length > max) {
        bootbox.alert(
          I18n.t("post.errors.too_many_dragged_and_dropped_files", {
            count: max,
          })
        );
        return false;
      }

      // Look for a matching file upload handler contributed from a plugin
      const matcher = (handler) => {
        const ext = handler.extensions.join("|");
        const regex = new RegExp(`\\.(${ext})$`, "i");
        return regex.test(data.files[0].name);
      };

      const matchingHandler = uploadHandlers.find(matcher);
      if (data.files.length === 1 && matchingHandler) {
        if (!matchingHandler.method(data.files[0], this)) {
          return false;
        }
      }

      // If no plugin, continue as normal
      const isPrivateMessage = this.get("composer.privateMessage");

      data.formData = { type: "composer" };
      if (isPrivateMessage) {
        data.formData.for_private_message = true;
      }
      if (this._pasted) {
        data.formData.pasted = true;
      }

      const opts = {
        user: this.currentUser,
        siteSettings: this.siteSettings,
        isPrivateMessage,
        allowStaffToUploadAnyFileInPm: this.siteSettings
          .allow_staff_to_upload_any_file_in_pm,
      };

      const isUploading = validateUploadedFiles(data.files, opts);

      run(() => {
        this.setProperties({ uploadProgress: 0, isUploading });
      });

      return isUploading;
    });

    $element.on("fileuploadprogressall", (e, data) => {
      run(() => {
        this.set(
          "uploadProgress",
          parseInt((data.loaded / data.total) * 100, 10)
        );
      });
    });

    $element.on("fileuploadsend", (e, data) => {
      run(() => {
        this._pasted = false;
        this._validUploads++;

        this._setUploadPlaceholderSend(data);

        this.appEvents.trigger("composer:insert-text", this.uploadPlaceholder);

        if (data.xhr && data.originalFiles.length === 1) {
          this.set("isCancellable", true);
          this._xhr = data.xhr();
        }
      });
    });

    $element.on("fileuploaddone", (e, data) => {
      run(() => {
        let upload = data.result;
        this._setUploadPlaceholderDone(data);
        if (!this._xhr || !this._xhr._userCancelled) {
          const markdown = uploadMarkdownResolvers.reduce(
            (md, resolver) => resolver(upload) || md,
            getUploadMarkdown(upload)
          );

          cacheShortUploadUrl(upload.short_url, upload);
          this.appEvents.trigger(
            "composer:replace-text",
            this.uploadPlaceholder.trim(),
            markdown
          );
          this._resetUpload(false);
        } else {
          this._resetUpload(true);
        }
      });
    });

    $element.on("fileuploadfail", (e, data) => {
      run(() => {
        this._setUploadPlaceholderDone(data);
        this._resetUpload(true);

        const userCancelled = this._xhr && this._xhr._userCancelled;
        this._xhr = null;

        if (!userCancelled) {
          displayErrorForUpload(data, this.siteSettings);
        }
      });
    });

    if (this.site.mobileView) {
      const uploadButton = document.getElementById("mobile-file-upload");
      uploadButton.addEventListener(
        "click",
        () => document.getElementById("file-uploader").click(),
        false
      );
    }
  },

  _registerImageScaleButtonClick($preview) {
    // original string `![image|foo=bar|690x220, 50%|bar=baz](upload://1TjaobgKObzpU7xRMw2HuUc87vO.png "image title")`
    // group 1 `image|foo=bar`
    // group 2 `690x220`
    // group 3 `, 50%`
    // group 4 '|bar=baz'
    // group 5 'upload://1TjaobgKObzpU7xRMw2HuUc87vO.png "image title"'

    // Notes:
    // Group 3 is optional. group 4 can match images with or without a markdown title.
    // All matches are whitespace tolerant as long it's still valid markdown.
    // If the image is inside a code block, we'll ignore it `(?!(.*`))`.
    const imageScaleRegex = /!\[(.*?)\|(\d{1,4}x\d{1,4})(,\s*\d{1,3}%)?(.*?)\]\((upload:\/\/.*?)\)(?!(.*`))/g;
    $preview.off("click", ".scale-btn").on("click", ".scale-btn", (e) => {
      const index = parseInt($(e.target).parent().attr("data-image-index"), 10);

      const scale = e.target.attributes["data-scale"].value;
      const matchingPlaceholder = this.get("composer.reply").match(
        imageScaleRegex
      );

      if (matchingPlaceholder) {
        const match = matchingPlaceholder[index];

        if (match) {
          const replacement = match.replace(
            imageScaleRegex,
            `![$1|$2, ${scale}%$4]($5)`
          );

          this.appEvents.trigger(
            "composer:replace-text",
            matchingPlaceholder[index],
            replacement,
            { regex: imageScaleRegex, index }
          );
        }
      }

      e.preventDefault();
      return;
    });
  },

  @on("willDestroyElement")
  _unbindUploadTarget() {
    this._validUploads = 0;
    $("#reply-control .mobile-file-upload").off("click.uploader");
    this.messageBus.unsubscribe("/uploads/composer");
    const $uploadTarget = $(this.element);
    try {
      $uploadTarget.fileupload("destroy");
    } catch (e) {
      /* wasn't initialized yet */
    }
    $uploadTarget.off();
  },

  @on("willDestroyElement")
  _composerClosed() {
    this.appEvents.trigger("composer:will-close");
    next(() => {
      // need to wait a bit for the "slide down" transition of the composer
      later(
        () => this.appEvents.trigger("composer:closed"),
        isTesting() ? 0 : 400
      );
    });

    if (this._enableAdvancedEditorPreviewSync()) {
      this._teardownInputPreviewSync();
    }
  },

  showUploadSelector(toolbarEvent) {
    this.send("showUploadSelector", toolbarEvent);
  },

  onExpandPopupMenuOptions(toolbarEvent) {
    const selected = toolbarEvent.selected;
    toolbarEvent.selectText(selected.start, selected.end - selected.start);
    this.storeToolbarState(toolbarEvent);
  },

  showPreview() {
    this.send("togglePreview");
  },

  _isInQuote(element) {
    let parent = element.parentElement;
    while (parent && !this._isPreviewRoot(parent)) {
      if (this._isQuote(parent)) {
        return true;
      }

      parent = parent.parentElement;
    }

    return false;
  },

  _isPreviewRoot(element) {
    return (
      element.tagName === "DIV" &&
      element.classList.contains("d-editor-preview")
    );
  },

  _isQuote(element) {
    return element.tagName === "ASIDE" && element.classList.contains("quote");
  },

  _cursorIsOnEmptyLine() {
    const textArea = this.element.querySelector(".d-editor-input");
    const selectionStart = textArea.selectionStart;
    if (selectionStart === 0) {
      return true;
    } else if (textArea.value.charAt(selectionStart - 1) === "\n") {
      return true;
    } else {
      return false;
    }
  },

  actions: {
    importQuote(toolbarEvent) {
      this.importQuote(toolbarEvent);
    },

    onExpandPopupMenuOptions(toolbarEvent) {
      this.onExpandPopupMenuOptions(toolbarEvent);
    },

    togglePreview() {
      this.togglePreview();
    },

    uploadWithUppy() {
      // eslint-disable-next-line no-console
      console.log("ok");
    },

    extraButtons(toolbar) {
      toolbar.addButton({
        id: "quote",
        group: "fontStyles",
        icon: "far-comment",
        sendAction: this.importQuote,
        title: "composer.quote_post_title",
        unshift: true,
      });

      if (this.allowUpload && this.uploadIcon && !this.site.mobileView) {
        toolbar.addButton({
          id: "upload",
          group: "insertions",
          icon: this.uploadIcon,
          title: "upload",
          sendAction: this.showUploadModal,
        });

        // uppy
        toolbar.addButton({
          id: "uploadUppy",
          group: "insertions",
          icon: "crosshairs",
          title: "composer.uppy_upload",
          sendAction: this.uploadWithUppy,
        });
      }

      toolbar.addButton({
        id: "options",
        group: "extras",
        icon: "cog",
        title: "composer.options",
        sendAction: this.onExpandPopupMenuOptions.bind(this),
        popupMenu: true,
      });
    },

    previewUpdated($preview) {
      // Paint mentions
      const unseenMentions = linkSeenMentions($preview, this.siteSettings);
      if (unseenMentions.length) {
        discourseDebounce(
          this,
          this._renderUnseenMentions,
          $preview,
          unseenMentions,
          450
        );
      }

      this._warnMentionedGroups($preview);
      this._warnCannotSeeMention($preview);

      // Paint category and tag hashtags
      const unseenHashtags = linkSeenHashtags($preview);
      if (unseenHashtags.length > 0) {
        discourseDebounce(this, this._renderUnseenHashtags, $preview, 450);
      }

      // Paint oneboxes
      const paintFunc = () => {
        const post = this.get("composer.post");
        let refresh = false;

        //If we are editing a post, we'll refresh its contents once.
        if (post && !post.get("refreshedPost")) {
          refresh = true;
        }

        const paintedCount = loadOneboxes(
          $preview[0],
          ajax,
          this.get("composer.topic.id"),
          this.get("composer.category.id"),
          this.siteSettings.max_oneboxes_per_post,
          refresh
        );

        if (refresh && paintedCount > 0) {
          post.set("refreshedPost", true);
        }
      };

      discourseDebounce(this, paintFunc, 450);

      // Short upload urls need resolution
      resolveAllShortUrls(ajax, this.siteSettings, $preview[0]);

      if (this._enableAdvancedEditorPreviewSync()) {
        this._syncScroll(
          this._syncEditorAndPreviewScroll,
          $(this.element.querySelector(".d-editor-input")),
          $preview
        );
      }

      this._registerImageScaleButtonClick($preview);

      this.trigger("previewRefreshed", $preview[0]);
      this.afterRefresh($preview);
    },
  },
});
