"use client"

import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
} from "react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  CheckCircle2,
  CircleAlert,
  Code2,
  ImagePlus,
  Info,
  Loader2,
  Upload,
  WandSparkles,
} from "lucide-react"
import { toast } from "sonner"
import {
  createSliceProposalDev,
  createSliceRendererProposalDev,
  createTextSliceProposalDev,
} from "@/app/(core)/admin/(authenticated)/slices/ai-actions"
import { persistGeneratedSlice } from "@/app/(core)/admin/(authenticated)/slices/create/actions"
import { DevAiReadinessNotice } from "@/components/admin/slices/dev-ai-readiness-notice"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  MAX_MEDIA_FILE_SIZE,
  formatBytes,
  prepareSnapshotForInlineAi,
} from "@/lib/media/snapshot-image-client"
import type { SectionBrief } from "@/lib/slices/authoring/author-result"
import {
  parseSliceProposalView,
  type SliceProposalView,
} from "@/lib/slices/authoring/proposal-view"
import { readDesignPixelWidth } from "@/lib/slices/authoring/design-upload"
import {
  DESIGN_WIDTH_QUESTION,
  parseDesignWidth,
} from "@/lib/slices/authoring/design-width"
import type { SliceVerificationScenario } from "@/lib/slices/verification"

type Translate = ReturnType<typeof useTranslations<"slices.create">>

type CatalogField = {
  path: string
  label: string
  kind: string
  scope: "Primary" | "Items"
  depth: number
  optional: boolean
  detail?: string
}

type CatalogItem = {
  type: string
  label: string
  description: string
  purpose: string
  fields: CatalogField[]
  fieldCount: number
  hasItems: boolean
}

type SnapshotImage = {
  file: File
  source: "paste" | "upload"
  /** Pixel width of the upload, shown beside the design-width question. */
  pixelWidth: number | null
}

type CreatedSliceNotice = {
  type: string
  label: string
  unrenderedFields: string[]
  usedDefaultLayout: boolean
}

type CreationStatus =
  | "idle"
  | "generating-proposal"
  | "reviewing-proposal"
  | "writing"
  | "renderer-failed"
  | "done"

type CreationMode = "prompt" | "snapshot" | "code"

type PreparedImage = { dataUrl: string; mediaType: string }

type PreparedProposal = {
  mode: CreationMode
  specJson: string
  modelId: string
  view: SliceProposalView
  image?: PreparedImage
  markup?: { source: string; lang: "html" | "tsx" }
  reference?: PreparedImage
  originalSnapshot?: File
  /** Answer to "How wide was this design made for?"; required to persist it. */
  designCssWidth?: number
}

/** Local Create attempt identity; it does not cancel an already dispatched action. */
type CreationRequest = Readonly<{
  epoch: number
  domain: "slice-create"
  mode: CreationMode
  contextKey: string
  imageFile: File | null
  verificationScenario?: SliceVerificationScenario
  accepted?: PreparedProposal
}>

type RendererFailure = {
  error: string
  previousAttempt?: string
}

type DecompositionContext = {
  sections: SectionBrief[]
  sourceMode: CreationMode
  hadPageImage: boolean
}

type CreationFlow = {
  status: CreationStatus
  message: string
  decomposition: DecompositionContext | null
  proposal: PreparedProposal | null
  rendererFailure: RendererFailure | null
  createdSlice: CreatedSliceNotice | null
}

type CreationFlowAction =
  | { type: "reset" }
  | { type: "retire-configuration" }
  | { type: "patch"; patch: Partial<CreationFlow> }

const INITIAL_CREATION_FLOW: CreationFlow = {
  status: "idle",
  message: "",
  decomposition: null,
  proposal: null,
  rendererFailure: null,
  createdSlice: null,
}

function reduceCreationFlow(
  state: CreationFlow,
  action: CreationFlowAction
): CreationFlow {
  if (action.type === "reset") return INITIAL_CREATION_FLOW
  if (action.type === "retire-configuration") {
    // Successful creation refreshes the catalog. Its terminal handoff is a
    // completed result, not a proposal that needs new configuration review.
    return state.status === "done" ? state : INITIAL_CREATION_FLOW
  }
  return { ...state, ...action.patch }
}

/** The proposal lives only in this browser tab (ADR-0053 A8 discloses it). */
function TabBoundNote() {
  const t = useTranslations("slices.create")
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Info className="size-3.5 shrink-0" aria-hidden />
      {t("tabBound")}
    </p>
  )
}

export function CreateSliceBrief({
  catalog,
  devAiReady,
  verificationScenario,
}: {
  catalog: CatalogItem[]
  /** Whether the Slice creator has a local key for the provider it would use
   *  (its saved choice in Settings → AI, or the default). Resolved on a local
   *  development server and passed in so this dev-only admin UI stops
   *  advertising Create buttons that would fail closed at the server action. */
  devAiReady: boolean
  verificationScenario?: SliceVerificationScenario
}) {
  const t = useTranslations("slices.create")
  const router = useRouter()
  const createSliceProposal = createSliceProposalDev
  const createTextSliceProposal = createTextSliceProposalDev
  const createSliceRendererProposal = createSliceRendererProposalDev
  const inputRef = useRef<HTMLInputElement>(null)
  const codeInputRef = useRef<HTMLInputElement>(null)
  const previewUrlRef = useRef<string | null>(null)
  const [image, setImage] = useState<SnapshotImage | null>(null)
  const [designWidth, setDesignWidth] = useState("")
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [suggestedName, setSuggestedName] = useState("")
  const [operatorNote, setOperatorNote] = useState("")
  const [promptBrief, setPromptBrief] = useState("")
  const [markup, setMarkup] = useState("")
  const [markupLang, setMarkupLang] = useState<"html" | "tsx">("html")
  const [activeMode, setActiveMode] = useState<CreationMode>("prompt")
  const [flow, dispatchFlow] = useReducer(
    reduceCreationFlow,
    INITIAL_CREATION_FLOW
  )
  const {
    status,
    message,
    decomposition,
    proposal,
    rendererFailure,
    createdSlice,
  } = flow
  const isBusy = status === "generating-proposal" || status === "writing"

  const requestEpochRef = useRef(0)
  const acceptedProposalRef = useRef<PreparedProposal | null>(null)
  const configurationKey = JSON.stringify({
    catalog,
    devAiReady,
    verificationScenario,
  })
  const contextKey = JSON.stringify({
    configurationKey,
    activeMode,
    suggestedName,
    operatorNote,
    promptBrief,
    markup,
    markupLang,
    designWidth,
    imageSource: image?.source,
  })
  const imageFile = image?.file ?? null
  const inputContextRef = useRef({ contextKey, configurationKey, imageFile })

  // Prop changes retire the same attempt as input edits. Pixel-width metadata
  // does not change the request; the exact uploaded File identity does.
  useLayoutEffect(() => {
    const previous = inputContextRef.current
    if (
      previous.contextKey !== contextKey ||
      previous.imageFile !== imageFile
    ) {
      requestEpochRef.current++
      acceptedProposalRef.current = null
      if (previous.configurationKey !== configurationKey) {
        dispatchFlow({ type: "retire-configuration" })
      }
    }
    inputContextRef.current = { contextKey, configurationKey, imageFile }
  }, [contextKey, configurationKey, imageFile])

  useLayoutEffect(
    () => () => {
      requestEpochRef.current++
      acceptedProposalRef.current = null
    },
    []
  )

  function beginRequest(
    mode: CreationMode,
    accepted?: PreparedProposal
  ): CreationRequest | null {
    if (
      !devAiReady ||
      mode !== activeMode ||
      (accepted && acceptedProposalRef.current !== accepted)
    ) {
      return null
    }
    const current = inputContextRef.current
    if (current.contextKey !== contextKey || current.imageFile !== imageFile) {
      return null
    }
    const epoch = ++requestEpochRef.current
    if (!accepted) acceptedProposalRef.current = null
    return {
      epoch,
      domain: "slice-create",
      mode,
      contextKey,
      imageFile,
      verificationScenario,
      accepted,
    }
  }

  function isCurrentRequest(request: CreationRequest): boolean {
    const current = inputContextRef.current
    return (
      request.domain === "slice-create" &&
      request.epoch === requestEpochRef.current &&
      request.contextKey === current.contextKey &&
      request.imageFile === current.imageFile &&
      (!request.accepted || request.accepted === acceptedProposalRef.current)
    )
  }

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  function resetOutputState() {
    requestEpochRef.current++
    acceptedProposalRef.current = null
    dispatchFlow({ type: "reset" })
  }

  function startSection(section: SectionBrief) {
    if (
      section.triage.decision !== "new-sibling" &&
      section.triage.decision !== "new-slice"
    ) {
      return
    }

    resetOutputState()
    const sourceMode = decomposition?.sourceMode
    const removedPageImage = decomposition?.hadPageImage === true
    if (removedPageImage) {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = null
      }
      setPreviewUrl(null)
      setImage(null)
    }

    setActiveMode("prompt")
    setSuggestedName(section.slug)
    setPromptBrief(buildSectionContinuationBrief(section))
    dispatchFlow({
      type: "patch",
      patch: {
        ...INITIAL_CREATION_FLOW,
        message: sectionContinuationMessage(t, sourceMode, removedPageImage),
      },
    })
  }

  function showDecomposition(
    sections: SectionBrief[],
    source: Pick<PreparedProposal, "mode" | "image">
  ) {
    dispatchFlow({
      type: "patch",
      patch: {
        status: "idle",
        message: "",
        decomposition: {
          sections,
          sourceMode: source.mode,
          hadPageImage: Boolean(source.image),
        },
        proposal: null,
        rendererFailure: null,
        createdSlice: null,
      },
    })
  }

  function finishCreatedSlice(
    persisted: {
      type: string
      label: string
      unrenderedFields?: string[]
    },
    usedDefaultLayout: boolean
  ) {
    const unrenderedFields = persisted.unrenderedFields ?? []
    toast.success(t("toast.created", { label: persisted.label }))
    router.refresh()
    dispatchFlow({
      type: "patch",
      patch: {
        status: "done",
        message: t("status.created", {
          label: persisted.label,
          type: persisted.type,
        }),
        rendererFailure: null,
        createdSlice: {
          type: persisted.type,
          label: persisted.label,
          unrenderedFields,
          usedDefaultLayout,
        },
      },
    })

    if (usedDefaultLayout || unrenderedFields.length > 0) {
      toast.warning(t("toast.rendererFollowUp"), {
        description: usedDefaultLayout
          ? t("toast.defaultLayout")
          : t("toast.notShownYet", { fields: unrenderedFields.join(", ") }),
      })
    }
  }

  function failProposal(error: unknown) {
    const text = errorText(error, t("errors.proposalFailed"))
    dispatchFlow({
      type: "patch",
      patch: { status: "idle", message: text },
    })
    toast.error(text)
  }

  function reviewProposal(
    request: CreationRequest,
    result: {
      specJson: string | null
      decomposition: SectionBrief[] | null
      modelId: string
    },
    source: Omit<PreparedProposal, "specJson" | "modelId" | "view">
  ) {
    if (!isCurrentRequest(request)) return
    if (result.decomposition) {
      showDecomposition(result.decomposition, source)
      return
    }
    if (!result.specJson) {
      dispatchFlow({
        type: "patch",
        patch: {
          status: "idle",
          message: t("status.noSpec", { model: result.modelId }),
        },
      })
      toast.warning(t("toast.noSpec"))
      return
    }

    const view = parseSliceProposalView(result.specJson)
    const prepared = {
      ...source,
      specJson: result.specJson,
      modelId: result.modelId,
      view,
    }
    acceptedProposalRef.current = prepared
    dispatchFlow({
      type: "patch",
      patch: {
        status: "reviewing-proposal",
        message: t("status.proposalReady", { model: result.modelId }),
        decomposition: null,
        proposal: prepared,
        rendererFailure: null,
        createdSlice: null,
      },
    })
  }

  function acceptImage(
    file: File | null | undefined,
    source: SnapshotImage["source"]
  ) {
    if (!file) return
    if (!file.type.startsWith("image/")) {
      dispatchFlow({
        type: "patch",
        patch: { message: t("validation.chooseImage") },
      })
      return
    }
    if (file.size > MAX_MEDIA_FILE_SIZE) {
      dispatchFlow({
        type: "patch",
        patch: {
          message: t("validation.smallerScreenshot", {
            size: formatBytes(MAX_MEDIA_FILE_SIZE),
          }),
        },
      })
      return
    }

    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    const nextUrl = URL.createObjectURL(file)
    previewUrlRef.current = nextUrl
    setPreviewUrl(nextUrl)
    setImage({ file, source, pixelWidth: null })
    setDesignWidth("")
    resetOutputState()
    // Reported for context in the design-width question; a file the browser
    // cannot decode simply shows no width rather than blocking the upload.
    void readDesignPixelWidth(file)
      .then((pixelWidth) =>
        setImage((current) =>
          current?.file === file ? { ...current, pixelWidth } : current
        )
      )
      .catch(() => {})
  }

  async function createFromPrompt() {
    const cleanBrief = promptBrief.trim()
    if (!cleanBrief) {
      dispatchFlow({
        type: "patch",
        patch: { message: t("validation.describeFirst") },
      })
      return
    }

    const request = beginRequest("prompt")
    if (!request) return
    dispatchFlow({
      type: "patch",
      patch: {
        status: "generating-proposal",
        message: t("status.runningAuthor"),
        decomposition: null,
        proposal: null,
        rendererFailure: null,
        createdSlice: null,
      },
    })

    try {
      const result = await createTextSliceProposal({
        brief: cleanBrief,
        suggestedName,
        verificationScenario: request.verificationScenario,
      })
      reviewProposal(request, result, { mode: "prompt" })
    } catch (error) {
      if (isCurrentRequest(request)) failProposal(error)
    }
  }

  async function createFromSnapshot() {
    if (!image) {
      dispatchFlow({
        type: "patch",
        patch: { message: t("validation.addSnapshotFirst") },
      })
      return
    }
    // Asked before any generation work so a missing answer costs nothing.
    const widthCheck = parseDesignWidth(designWidth)
    if (!widthCheck.ok) {
      dispatchFlow({ type: "patch", patch: { message: widthCheck.error } })
      return
    }

    const request = beginRequest("snapshot")
    if (!request) return
    dispatchFlow({
      type: "patch",
      patch: {
        status: "generating-proposal",
        message: t("status.preparingSnapshot"),
        decomposition: null,
        proposal: null,
        rendererFailure: null,
        createdSlice: null,
      },
    })

    try {
      const aiImage = await prepareSnapshotForInlineAi(image.file)
      if (!isCurrentRequest(request)) return

      dispatchFlow({
        type: "patch",
        patch: { message: t("status.runningAuthor") },
      })
      const result = await createSliceProposal({
        brief: operatorNote,
        suggestedName,
        imageDataUrl: aiImage.dataUrl,
        imageMediaType: aiImage.mediaType,
        verificationScenario: request.verificationScenario,
      })
      const reference = {
        dataUrl: aiImage.dataUrl,
        mediaType: aiImage.mediaType,
      }
      reviewProposal(request, result, {
        mode: "snapshot",
        image: aiImage,
        reference,
        originalSnapshot: image.file,
        designCssWidth: widthCheck.cssWidth,
      })
    } catch (error) {
      if (isCurrentRequest(request)) failProposal(error)
    }
  }

  // From code: the design's real HTML/TSX is the structural source of truth, so
  // the screenshot is an optional visual cross-check (see ADR-0016). Markup
  // alone can drive generation; an image, when added, sharpens fidelity.
  async function createFromCode() {
    const cleanMarkup = markup.trim()
    if (!cleanMarkup) {
      dispatchFlow({
        type: "patch",
        patch: { message: t("validation.pasteMarkupFirst") },
      })
      return
    }
    // A design supplied here needs its width too, or it would be silently
    // dropped at persist time and the slice would ship with no baseline.
    const codeWidth = image ? parseDesignWidth(designWidth) : null
    if (codeWidth && !codeWidth.ok) {
      dispatchFlow({ type: "patch", patch: { message: codeWidth.error } })
      return
    }

    const request = beginRequest("code")
    if (!request) return
    dispatchFlow({
      type: "patch",
      patch: {
        status: "generating-proposal",
        message: t("status.runningAuthor"),
        decomposition: null,
        proposal: null,
        rendererFailure: null,
        createdSlice: null,
      },
    })

    try {
      let aiImage: PreparedImage | undefined
      let reference: PreparedImage | undefined
      if (image) {
        dispatchFlow({
          type: "patch",
          patch: { message: t("status.preparingSnapshot") },
        })
        const prepared = await prepareSnapshotForInlineAi(image.file)
        if (!isCurrentRequest(request)) return
        aiImage = { dataUrl: prepared.dataUrl, mediaType: prepared.mediaType }
        reference = { dataUrl: prepared.dataUrl, mediaType: prepared.mediaType }
      }

      dispatchFlow({
        type: "patch",
        patch: { message: t("status.runningAuthor") },
      })
      const result = await createSliceProposal({
        brief: operatorNote,
        suggestedName,
        imageDataUrl: aiImage?.dataUrl,
        imageMediaType: aiImage?.mediaType,
        sourceMarkup: cleanMarkup,
        markupLang,
        verificationScenario: request.verificationScenario,
      })
      reviewProposal(request, result, {
        mode: "code",
        image: aiImage,
        markup: { source: cleanMarkup, lang: markupLang },
        reference,
        originalSnapshot: image?.file,
        designCssWidth: codeWidth?.ok ? codeWidth.cssWidth : undefined,
      })
    } catch (error) {
      if (isCurrentRequest(request)) failProposal(error)
    }
  }

  async function generateProposal(mode: CreationMode) {
    if (mode === "prompt") return createFromPrompt()
    if (mode === "snapshot") return createFromSnapshot()
    return createFromCode()
  }

  function originalSnapshotFormData(
    accepted: PreparedProposal
  ): FormData | undefined {
    if (!accepted.originalSnapshot || accepted.designCssWidth === undefined) {
      return undefined
    }
    const formData = new FormData()
    formData.set("snapshot", accepted.originalSnapshot)
    formData.set("cssWidth", String(accepted.designCssWidth))
    formData.set("variant", "desktop")
    return formData
  }

  async function persistAcceptedRenderer(
    request: CreationRequest,
    accepted: PreparedProposal,
    rendererBody: string | null
  ) {
    // No await between this guard and dispatch. Once dispatched, a server-side
    // write may complete even if the local attempt is subsequently retired.
    if (!isCurrentRequest(request)) return null
    return persistGeneratedSlice(
      accepted.specJson,
      originalSnapshotFormData(accepted),
      rendererBody
    )
  }

  async function writeCode(
    accepted: PreparedProposal,
    initialFailure?: RendererFailure
  ) {
    const request = beginRequest(accepted.mode, accepted)
    if (!request) return
    dispatchFlow({
      type: "patch",
      patch: {
        status: "writing",
        message: t("status.generatingRenderer"),
        rendererFailure: null,
      },
    })
    let previousAttempt = initialFailure?.previousAttempt
    let previousError = initialFailure?.error

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!isCurrentRequest(request)) return
      dispatchFlow({
        type: "patch",
        patch: {
          message:
            attempt === 1
              ? t("status.generatingRenderer")
              : t("status.retryingRenderer"),
        },
      })
      try {
        const rendererResult = await createSliceRendererProposal({
          specJson: accepted.specJson,
          imageDataUrl: accepted.image?.dataUrl,
          imageMediaType: accepted.image?.mediaType,
          sourceMarkup: accepted.markup?.source,
          markupLang: accepted.markup?.lang,
          previousAttempt,
          previousError,
          verificationScenario: request.verificationScenario,
        })
        if (!isCurrentRequest(request)) return
        if (!rendererResult.rendererBody) {
          previousAttempt = undefined
          previousError = "Renderer proposal returned no JSX body."
          continue
        }

        try {
          const persisted = await persistAcceptedRenderer(
            request,
            accepted,
            rendererResult.rendererBody
          )
          if (!isCurrentRequest(request) || !persisted) return
          finishCreatedSlice(persisted, false)
          return
        } catch (gateError) {
          if (!isCurrentRequest(request)) return
          previousAttempt = rendererResult.rendererBody
          previousError = errorText(gateError, "Renderer verification failed")
        }
      } catch (rendererError) {
        if (!isCurrentRequest(request)) return
        previousAttempt = undefined
        previousError = errorText(rendererError, "Renderer generation failed")
      }
    }

    if (!isCurrentRequest(request)) return
    const failure = {
      error: previousError ?? t("errors.rendererFailedWithoutError"),
      previousAttempt,
    }
    dispatchFlow({
      type: "patch",
      patch: {
        status: "renderer-failed",
        message: failure.error,
        rendererFailure: failure,
      },
    })
  }

  async function createWithDefaultLayout(accepted: PreparedProposal) {
    const request = beginRequest(accepted.mode, accepted)
    if (!request) return
    dispatchFlow({
      type: "patch",
      patch: {
        status: "writing",
        message: t("status.creatingDefault"),
      },
    })
    try {
      const persisted = await persistAcceptedRenderer(request, accepted, null)
      if (!isCurrentRequest(request) || !persisted) return
      finishCreatedSlice(persisted, true)
    } catch (error) {
      if (!isCurrentRequest(request)) return
      const failure = {
        error: errorText(error, t("errors.defaultLayoutFailed")),
      }
      dispatchFlow({
        type: "patch",
        patch: {
          status: "renderer-failed",
          message: failure.error,
          rendererFailure: failure,
        },
      })
      toast.error(failure.error)
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const file = Array.from(event.clipboardData.files).find((item) =>
      item.type.startsWith("image/")
    )
    if (!file) return

    event.preventDefault()
    acceptImage(file, "paste")
  }

  return (
    <div className="max-w-3xl space-y-4" onPaste={handlePaste}>
      <DevAiReadinessNotice ready={devAiReady} />
      <Tabs
        value={activeMode}
        onValueChange={(value) => {
          setActiveMode(value as CreationMode)
          resetOutputState()
        }}
        className="gap-4"
      >
        <TabsList>
          <TabsTrigger value="prompt" disabled={isBusy}>
            {t("tabs.prompt")}
          </TabsTrigger>
          <TabsTrigger value="snapshot" disabled={isBusy}>
            {t("tabs.snapshot")}
          </TabsTrigger>
          <TabsTrigger value="code" disabled={isBusy}>
            {t("tabs.code")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="prompt">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{t("tabs.prompt")}</CardTitle>
                <Badge variant="outline">{t("badges.devOnly")}</Badge>
                <Badge variant="secondary">
                  {t("badges.localCodeWrite")}
                </Badge>
              </div>
              <CardDescription>{t("prompt.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                <div className="space-y-2">
                  <Label htmlFor="prompt-slice-name">
                    {t("fields.suggestedName")}
                  </Label>
                  <Input
                    id="prompt-slice-name"
                    value={suggestedName}
                    disabled={isBusy}
                    placeholder={t("fields.faqNamePlaceholder")}
                    onChange={(event) => {
                      setSuggestedName(event.target.value)
                      resetOutputState()
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="prompt-brief">{t("prompt.label")}</Label>
                  <Textarea
                    id="prompt-brief"
                    value={promptBrief}
                    disabled={isBusy}
                    placeholder={t("prompt.placeholder")}
                    className="min-h-28"
                    onChange={(event) => {
                      setPromptBrief(event.target.value)
                      resetOutputState()
                    }}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    onClick={createFromPrompt}
                    disabled={!devAiReady || !promptBrief.trim() || isBusy}
                  >
                    {status === "generating-proposal" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <WandSparkles className="size-4" />
                    )}
                    {t("generate")}
                  </Button>
                  {message &&
                    status !== "renderer-failed" &&
                    status !== "done" && (
                      <p
                        className="text-sm whitespace-pre-wrap text-muted-foreground"
                        role="status"
                      >
                        {message}
                      </p>
                    )}
                </div>
                <TabBoundNote />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="snapshot">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{t("tabs.snapshot")}</CardTitle>
                <Badge variant="outline">{t("badges.devOnly")}</Badge>
                <Badge variant="secondary">
                  {t("badges.localCodeWrite")}
                </Badge>
              </div>
              <CardDescription>{t("snapshot.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <input
                ref={inputRef}
                type="file"
                disabled={isBusy}
                aria-label={t("snapshot.uploadLabel")}
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  acceptImage(event.target.files?.[0], "upload")
                  event.currentTarget.value = ""
                }}
              />

              <div className="space-y-2">
                <Label htmlFor="slice-snapshot-button">
                  {t("snapshot.imageLabel")}
                </Label>
                <button
                  id="slice-snapshot-button"
                  type="button"
                  disabled={isBusy}
                  className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/30 text-left transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => inputRef.current?.click()}
                >
                  {previewUrl ? (
                    // Blob URLs are browser-local previews — unoptimized skips the Next.js image pipeline.
                    <Image
                      src={previewUrl}
                      alt={t("snapshot.previewAlt")}
                      fill
                      sizes="(max-width: 768px) 100vw, 640px"
                      unoptimized
                      className="object-contain"
                    />
                  ) : (
                    <span className="flex flex-col items-center gap-2 px-6 text-center text-sm text-muted-foreground">
                      <ImagePlus className="size-8" />
                      {t("snapshot.empty")}
                    </span>
                  )}
                </button>
                {image && (
                  <p className="truncate text-xs text-muted-foreground">
                    {image.file.name || t("snapshot.clipboardImage")} -{" "}
                    {image.file.type} -{" "}
                    {formatBytes(image.file.size)} - {image.source}
                  </p>
                )}
              </div>

              {image && (
                <DesignWidthField
                  id="slice-design-width"
                  pixelWidth={image.pixelWidth}
                  value={designWidth}
                  disabled={isBusy}
                  onChange={(value) => {
                    setDesignWidth(value)
                    resetOutputState()
                  }}
                />
              )}

              <div className="grid gap-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                <div className="space-y-2">
                  <Label htmlFor="slice-name">{t("fields.suggestedName")}</Label>
                  <Input
                    id="slice-name"
                    value={suggestedName}
                    disabled={isBusy}
                    placeholder={t("fields.faqNamePlaceholder")}
                    onChange={(event) => {
                      setSuggestedName(event.target.value)
                      resetOutputState()
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="operator-note">
                    {t("fields.operatorNote")}
                  </Label>
                  <Textarea
                    id="operator-note"
                    value={operatorNote}
                    disabled={isBusy}
                    placeholder={t("fields.operatorNotePlaceholder")}
                    className="min-h-24"
                    onChange={(event) => {
                      setOperatorNote(event.target.value)
                      resetOutputState()
                    }}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    onClick={createFromSnapshot}
                    disabled={!devAiReady || !image || isBusy}
                  >
                    {status === "generating-proposal" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <WandSparkles className="size-4" />
                    )}
                    {t("generate")}
                  </Button>
                  {devAiReady && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => inputRef.current?.click()}
                      disabled={isBusy}
                    >
                      <Upload className="size-4" />
                      {t("snapshot.upload")}
                    </Button>
                  )}
                  {message &&
                    status !== "renderer-failed" &&
                    status !== "done" && (
                      <p
                        className="text-sm whitespace-pre-wrap text-muted-foreground"
                        role="status"
                      >
                        {message}
                      </p>
                    )}
                </div>
                <TabBoundNote />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="code">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{t("tabs.code")}</CardTitle>
                <Badge variant="outline">{t("badges.devOnly")}</Badge>
                <Badge variant="secondary">
                  {t("badges.localCodeWrite")}
                </Badge>
                <Badge variant="secondary">
                  {t("badges.structuralSource")}
                </Badge>
              </div>
              <CardDescription>{t("code.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <input
                ref={codeInputRef}
                type="file"
                disabled={isBusy}
                accept="image/*"
                aria-label={t("code.uploadLabel")}
                className="hidden"
                onChange={(event) => {
                  acceptImage(event.target.files?.[0], "upload")
                  event.currentTarget.value = ""
                }}
              />

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="slice-markup">{t("code.markupLabel")}</Label>
                  <div className="inline-flex overflow-hidden rounded-md border">
                    {(["html", "tsx"] as const).map((lang) => (
                      <button
                        key={lang}
                        type="button"
                        disabled={isBusy}
                        aria-pressed={markupLang === lang}
                        className={`px-3 py-1 text-xs font-medium transition-colors ${
                          markupLang === lang
                            ? "bg-foreground text-background"
                            : "bg-transparent text-muted-foreground hover:text-foreground"
                        }`}
                        onClick={() => {
                          setMarkupLang(lang)
                          resetOutputState()
                        }}
                      >
                        {lang.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <Textarea
                  id="slice-markup"
                  value={markup}
                  disabled={isBusy}
                  placeholder={
                    markupLang === "html"
                      ? t.raw("code.markupPlaceholderHtml")
                      : t.raw("code.markupPlaceholderTsx")
                  }
                  className="min-h-48 font-mono text-xs"
                  onChange={(event) => {
                    setMarkup(event.target.value)
                    resetOutputState()
                  }}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                <div className="space-y-2">
                  <Label htmlFor="code-slice-name">
                    {t("fields.suggestedName")}
                  </Label>
                  <Input
                    id="code-slice-name"
                    value={suggestedName}
                    disabled={isBusy}
                    placeholder={t("code.namePlaceholder")}
                    onChange={(event) => {
                      setSuggestedName(event.target.value)
                      resetOutputState()
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="code-operator-note">
                    {t("fields.operatorNote")}
                  </Label>
                  <Textarea
                    id="code-operator-note"
                    value={operatorNote}
                    disabled={isBusy}
                    placeholder={t("fields.operatorNotePlaceholder")}
                    className="min-h-24"
                    onChange={(event) => {
                      setOperatorNote(event.target.value)
                      resetOutputState()
                    }}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t("code.optionalSnapshot")}</Label>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => codeInputRef.current?.click()}
                    disabled={isBusy}
                  >
                    <ImagePlus className="size-4" />
                    {image ? t("code.replaceImage") : t("code.addImage")}
                  </Button>
                  {previewUrl && (
                    // Blob URLs are browser-local previews — unoptimized skips the Next.js image pipeline.
                    <Image
                      src={previewUrl}
                      alt={t("code.previewAlt")}
                      width={80}
                      height={48}
                      unoptimized
                      className="h-12 w-auto rounded border object-contain"
                    />
                  )}
                  {image && (
                    <span className="truncate text-xs text-muted-foreground">
                      {image.file.name || t("snapshot.clipboardImage")} -{" "}
                      {formatBytes(image.file.size)}
                    </span>
                  )}
                </div>
              </div>

              {image && (
                <DesignWidthField
                  id="code-design-width"
                  pixelWidth={image.pixelWidth}
                  value={designWidth}
                  disabled={isBusy}
                  onChange={(value) => {
                    setDesignWidth(value)
                    resetOutputState()
                  }}
                />
              )}

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    onClick={createFromCode}
                    disabled={!devAiReady || !markup.trim() || isBusy}
                  >
                    {status === "generating-proposal" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Code2 className="size-4" />
                    )}
                    {t("generate")}
                  </Button>
                  {message &&
                    status !== "renderer-failed" &&
                    status !== "done" && (
                      <p
                        className="text-sm whitespace-pre-wrap text-muted-foreground"
                        role="status"
                      >
                        {message}
                      </p>
                    )}
                </div>
                <TabBoundNote />
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      {proposal &&
        (status === "reviewing-proposal" || status === "writing") && (
          <SliceProposalReview
            proposal={proposal}
            writing={status === "writing"}
            message={message}
            onRevise={resetOutputState}
            onRegenerate={() => generateProposal(proposal.mode)}
            onWrite={() => writeCode(proposal)}
          />
        )}
      {proposal && status === "renderer-failed" && rendererFailure && (
        <RendererFailureNotice
          error={rendererFailure.error}
          onRevise={resetOutputState}
          onRetry={() => writeCode(proposal, rendererFailure)}
          onDefault={() => createWithDefaultLayout(proposal)}
        />
      )}
      {decomposition && (
        <div className="mt-4 rounded-md border bg-muted/40 px-4 py-4 text-sm">
          <p className="font-medium text-foreground">
            {decompositionHeading(t, decomposition.sections)}
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted-foreground">
            {decomposition.sections.map((section) => (
              <li
                key={`${section.order}:${section.slug}`}
                className="space-y-2"
              >
                <div>
                  <span className="font-mono text-foreground">
                    {section.slug}
                  </span>
                  {" — "}
                  <span className="font-medium text-foreground">
                    {triageLabel(t, section.triage)}
                  </span>
                  {section.purpose ? ` — ${section.purpose}` : null}
                </div>
                {section.triage.decision === "reuse" && (
                  <div className="flex flex-wrap gap-2">
                    <Button asChild size="sm">
                      <Link href={`/admin/slices/${section.triage.type}`}>
                        {t("decomposition.open", { type: section.triage.type })}
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/slice-sim/${section.triage.type}`}>
                        {t("decomposition.openSimulator")}
                      </Link>
                    </Button>
                  </div>
                )}
                {section.triage.decision === "new-presentation" && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {t("decomposition.presentationReview")}
                    </p>
                    <p className="font-mono text-xs break-all">
                      {section.triage.contractSha256}
                    </p>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/slice-sim/${section.triage.type}`}>
                        {t("decomposition.inspectRenderer")}
                      </Link>
                    </Button>
                  </div>
                )}
                {(section.triage.decision === "new-sibling" ||
                  section.triage.decision === "new-slice") && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => startSection(section)}
                  >
                    {t("decomposition.start")}
                  </Button>
                )}
                {section.triage.decision === "app-shell" && (
                  <p className="text-muted-foreground">
                    {t("decomposition.appShellHint")}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {createdSlice && status === "done" && (
        <CreatedSliceHandoff created={createdSlice} />
      )}
    </div>
  )
}

function SliceProposalReview({
  proposal,
  writing,
  message,
  onRevise,
  onRegenerate,
  onWrite,
}: {
  proposal: PreparedProposal
  writing: boolean
  message: string
  onRevise: () => void
  onRegenerate: () => void
  onWrite: () => void
}) {
  const t = useTranslations("slices.create")
  const view = proposal.view
  return (
    <section className="space-y-5 rounded-xl border bg-card p-5 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t("review.title")}</h2>
          <p className="text-muted-foreground">{t("review.note")}</p>
        </div>
        <Badge variant="outline">{proposal.modelId}</Badge>
      </div>

      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">{t("review.type")}</dt>
          <dd className="font-mono text-foreground">{view.type}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("review.label")}</dt>
          <dd className="text-foreground">{view.label}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("review.group")}</dt>
          <dd className="text-foreground">{view.group}</dd>
        </div>
      </dl>

      <div>
        <p className="text-xs text-muted-foreground">{t("review.purpose")}</p>
        <p className="mt-1 text-foreground">{view.purpose}</p>
      </div>

      <ProposalFieldGroup
        title={t("review.primaryFields")}
        fields={view.primaryFields}
      />
      <ProposalFieldGroup
        title={t("review.itemShape")}
        fields={view.itemFields}
        empty={t("review.noItems")}
        detail={view.itemBounds}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onRevise}
          disabled={writing}
        >
          {t("review.revise")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onRegenerate}
          disabled={writing}
        >
          {t("review.regenerate")}
        </Button>
        <Button type="button" onClick={onWrite} disabled={writing}>
          {writing ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("review.write")}
        </Button>
        {writing && (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        )}
      </div>
    </section>
  )
}

function ProposalFieldGroup({
  title,
  fields,
  empty,
  detail,
}: {
  title: string
  fields: SliceProposalView["primaryFields"]
  empty?: string
  detail?: string | null
}) {
  const t = useTranslations("slices.create")
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-foreground">{title}</h3>
        {detail ? <Badge variant="secondary">{detail}</Badge> : null}
      </div>
      {fields.length === 0 ? (
        <p className="text-muted-foreground">{empty ?? t("review.noFields")}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {fields.map((field) => (
            <li
              key={field.path}
              className="flex flex-wrap items-center gap-2 px-3 py-2"
              style={{ paddingLeft: `${0.75 + field.depth * 1.25}rem` }}
            >
              <span className="font-mono text-foreground">
                {field.path.split(".").at(-1)}
              </span>
              <Badge variant="outline">{field.kind}</Badge>
              <span className="text-xs text-muted-foreground">
                {field.optional ? t("review.optional") : t("review.required")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RendererFailureNotice({
  error,
  onRevise,
  onRetry,
  onDefault,
}: {
  error: string
  onRevise: () => void
  onRetry: () => void
  onDefault: () => void
}) {
  const t = useTranslations("slices.create")
  return (
    <section className="space-y-4 rounded-xl border p-5 text-sm" role="alert">
      <div className="flex gap-3">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="space-y-1">
          <h2 className="font-semibold text-foreground">
            {t("rendererFailure.title")}
          </h2>
          <p className="whitespace-pre-wrap text-muted-foreground">{error}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onRevise}>
          {t("rendererFailure.revise")}
        </Button>
        <Button type="button" variant="outline" onClick={onRetry}>
          {t("rendererFailure.retry")}
        </Button>
        <Button type="button" onClick={onDefault}>
          {t("rendererFailure.useDefault")}
        </Button>
      </div>
    </section>
  )
}

function CreatedSliceHandoff({ created }: { created: CreatedSliceNotice }) {
  const t = useTranslations("slices.create")
  const needsRendererWork =
    created.usedDefaultLayout || created.unrenderedFields.length > 0

  return (
    <section className="space-y-4 rounded-xl border p-5 text-sm">
      <div className="flex gap-3">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        <div className="space-y-1">
          <h2 className="font-semibold text-foreground">
            {t("handoff.title", { label: created.label })}
          </h2>
          {created.usedDefaultLayout ? (
            <p className="text-muted-foreground">
              {t("handoff.defaultLayout")}
            </p>
          ) : needsRendererWork ? (
            <p className="text-muted-foreground">
              {t.rich("handoff.followUp", {
                fields: created.unrenderedFields.join(", "),
                mono: (chunks) => <span className="font-mono">{chunks}</span>,
              })}
            </p>
          ) : (
            <p className="text-muted-foreground">{t("handoff.next")}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link href={`/admin/slices/${created.type}`}>
            {t("handoff.reviewModel")}
          </Link>
        </Button>
        <Button asChild>
          <Link href={`/slice-sim/${created.type}`}>
            {t("handoff.tune")}
          </Link>
        </Button>
      </div>
    </section>
  )
}

function errorText(error: unknown, fallback: string): string {
  const text =
    error instanceof Error ? error.message : String(error || fallback)
  return text.trim().slice(0, 1_600) || fallback
}

function triageLabel(t: Translate, triage: SectionBrief["triage"]): string {
  if (triage.decision === "reuse") {
    return t("triage.reuse", { type: triage.type })
  }
  if (triage.decision === "new-presentation") {
    return t("triage.newPresentation", { type: triage.type })
  }
  if (triage.decision === "new-sibling") {
    return t("triage.newSibling", { family: triage.family })
  }
  if (triage.decision === "app-shell") return t("triage.appShell")
  return t("triage.newSlice")
}

function decompositionHeading(t: Translate, sections: SectionBrief[]): string {
  if (sections.length > 1) {
    return t("decomposition.page")
  }
  const triage = sections[0]?.triage
  if (triage?.decision === "reuse") {
    return t("decomposition.reuse", { type: triage.type })
  }
  if (triage?.decision === "new-presentation") {
    return t("decomposition.newPresentation", { type: triage.type })
  }
  if (triage?.decision === "app-shell") {
    return t("decomposition.appShell")
  }
  return t("decomposition.noSlice")
}

function buildSectionContinuationBrief(section: SectionBrief): string {
  const lines = [
    "Create one independently placeable Slice section.",
    `Purpose: ${section.purpose}`,
  ]
  if (section.triage.decision === "new-sibling") {
    lines.push(
      `Family: ${section.triage.family}`,
      "Create a new Slice Type identity for this structural sibling. Do not change or reuse the existing family type."
    )
  } else {
    lines.push("Create a new reusable Slice Type for this section.")
  }
  return lines.join("\n")
}

function sectionContinuationMessage(
  t: Translate,
  sourceMode: CreationMode | undefined,
  removedPageImage: boolean
): string {
  if (removedPageImage && sourceMode === "code") {
    return t("continuation.pageImageAndMarkup")
  }
  if (removedPageImage) {
    return t("continuation.pageImage")
  }
  if (sourceMode === "code") {
    return t("continuation.pageMarkup")
  }
  return t("continuation.ready")
}

/**
 * The "How wide was this design made for?" question (slice-fidelity plan §5
 * B2). Shown wherever a design can be supplied, because a design saved without
 * its width has no comparable baseline.
 */
function DesignWidthField({
  id,
  pixelWidth,
  value,
  disabled,
  onChange,
}: {
  id: string
  pixelWidth: number | null
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const t = useTranslations("slices.create")
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{DESIGN_WIDTH_QUESTION}</Label>
      <Input
        id={id}
        inputMode="numeric"
        placeholder="1440"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        {pixelWidth
          ? `${t("designWidth.pixelWidth", { width: String(pixelWidth) })} `
          : ""}
        {t("designWidth.hint")}
      </p>
    </div>
  )
}
