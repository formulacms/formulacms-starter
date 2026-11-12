// Public-site interface copy (M05 M20, owner decision 2026-09-15: Option A).
// Every supported locale carries every string, so a public response is always
// presented in one language: the not-found, error and loading screens and the
// language switcher never fall back to another locale's copy. Page content
// comes from the CMS; only this fixed chrome lives here.
import { FALLBACK_LOCALE, SUPPORTED_LOCALES } from "./config"

export type PublicMessages = {
  chrome: PublicChrome
  notFound: { title: string; body: string }
  error: { eyebrow: string; title: string; body: string; retry: string }
  /** Link back to the presentation language's home page. */
  home: string
  loading: string
  languageSwitcher: {
    /** Accessible name prefix: "<label>, <CODE>". */
    label: string
    /** Shown while the switcher checks which languages have this page. */
    checking: string
    /** Accessible suffix on a language that has no version of this page. */
    unavailable: string
  }
}

type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

type PublicChrome = {
  homeLabel: string
  siteLogo: string
  footerNavigation: string
  rightsReserved: string
  checkingSession: string
  signIn: string
  loggedIn: string
  signedInAs: string
  admin: string
  signingOut: string
  logOut: string
  navigationMenu: string
  openMenu: string
  siteNavigation: string
  mainNavigation: string
  close: string
  noContent: string
  faqQuestions: string
  previewShowing: string
  exitPreview: string
  by: string
  other: string
  others: string
  draft: string
  published: string
  archived: string
}

const PUBLIC_CHROME = {
  en: {
    homeLabel: "Home",
    siteLogo: "Site logo",
    footerNavigation: "Footer navigation",
    rightsReserved: "All rights reserved.",
    checkingSession: "Checking session",
    signIn: "Sign in",
    loggedIn: "Logged in",
    signedInAs: "Signed in as",
    admin: "Admin",
    signingOut: "Signing out...",
    logOut: "Log out",
    navigationMenu: "Navigation menu",
    openMenu: "Open menu",
    siteNavigation: "Site navigation",
    mainNavigation: "Main navigation",
    close: "Close",
    noContent: "No content yet.",
    faqQuestions: "{heading} questions",
    previewShowing: "Preview mode: showing {status} content",
    exitPreview: "Exit preview",
    by: "By",
    other: "other",
    others: "others",
    draft: "draft",
    published: "published",
    archived: "archived",
  },
  fr: {
    homeLabel: "Accueil",
    siteLogo: "Logo du site",
    footerNavigation: "Navigation de pied de page",
    rightsReserved: "Tous droits réservés.",
    checkingSession: "Vérification de la session",
    signIn: "Se connecter",
    loggedIn: "Connecté",
    signedInAs: "Connecté en tant que",
    admin: "Administration",
    signingOut: "Déconnexion…",
    logOut: "Se déconnecter",
    navigationMenu: "Menu de navigation",
    openMenu: "Ouvrir le menu",
    siteNavigation: "Navigation du site",
    mainNavigation: "Navigation principale",
    close: "Fermer",
    noContent: "Aucun contenu pour le moment.",
    faqQuestions: "Questions : {heading}",
    previewShowing: "Aperçu : contenu {status}",
    exitPreview: "Quitter l’aperçu",
    by: "Par",
    other: "autre",
    others: "autres",
    draft: "brouillon",
    published: "publié",
    archived: "archivé",
  },
  es: {
    homeLabel: "Inicio",
    siteLogo: "Logotipo del sitio",
    footerNavigation: "Navegación del pie de página",
    rightsReserved: "Todos los derechos reservados.",
    checkingSession: "Comprobando la sesión",
    signIn: "Iniciar sesión",
    loggedIn: "Sesión iniciada",
    signedInAs: "Sesión iniciada como",
    admin: "Administración",
    signingOut: "Cerrando sesión…",
    logOut: "Cerrar sesión",
    navigationMenu: "Menú de navegación",
    openMenu: "Abrir menú",
    siteNavigation: "Navegación del sitio",
    mainNavigation: "Navegación principal",
    close: "Cerrar",
    noContent: "Aún no hay contenido.",
    faqQuestions: "Preguntas: {heading}",
    previewShowing: "Vista previa: contenido {status}",
    exitPreview: "Salir de la vista previa",
    by: "Por",
    other: "más",
    others: "más",
    draft: "borrador",
    published: "publicado",
    archived: "archivado",
  },
  it: {
    homeLabel: "Home",
    siteLogo: "Logo del sito",
    footerNavigation: "Navigazione a piè di pagina",
    rightsReserved: "Tutti i diritti riservati.",
    checkingSession: "Verifica della sessione",
    signIn: "Accedi",
    loggedIn: "Accesso effettuato",
    signedInAs: "Accesso effettuato come",
    admin: "Amministrazione",
    signingOut: "Disconnessione…",
    logOut: "Esci",
    navigationMenu: "Menu di navigazione",
    openMenu: "Apri menu",
    siteNavigation: "Navigazione del sito",
    mainNavigation: "Navigazione principale",
    close: "Chiudi",
    noContent: "Nessun contenuto per ora.",
    faqQuestions: "Domande: {heading}",
    previewShowing: "Anteprima: contenuto {status}",
    exitPreview: "Esci dall’anteprima",
    by: "Di",
    other: "altro",
    others: "altri",
    draft: "bozza",
    published: "pubblicato",
    archived: "archiviato",
  },
  pt: {
    homeLabel: "Início",
    siteLogo: "Logótipo do site",
    footerNavigation: "Navegação do rodapé",
    rightsReserved: "Todos os direitos reservados.",
    checkingSession: "A verificar a sessão",
    signIn: "Iniciar sessão",
    loggedIn: "Sessão iniciada",
    signedInAs: "Sessão iniciada como",
    admin: "Administração",
    signingOut: "A terminar sessão…",
    logOut: "Terminar sessão",
    navigationMenu: "Menu de navegação",
    openMenu: "Abrir menu",
    siteNavigation: "Navegação do site",
    mainNavigation: "Navegação principal",
    close: "Fechar",
    noContent: "Ainda não há conteúdo.",
    faqQuestions: "Perguntas: {heading}",
    previewShowing: "Pré-visualização: conteúdo {status}",
    exitPreview: "Sair da pré-visualização",
    by: "Por",
    other: "outro",
    others: "outros",
    draft: "rascunho",
    published: "publicado",
    archived: "arquivado",
  },
  "pt-br": {
    homeLabel: "Início",
    siteLogo: "Logo do site",
    footerNavigation: "Navegação do rodapé",
    rightsReserved: "Todos os direitos reservados.",
    checkingSession: "Verificando a sessão",
    signIn: "Entrar",
    loggedIn: "Conectado",
    signedInAs: "Conectado como",
    admin: "Administração",
    signingOut: "Saindo…",
    logOut: "Sair",
    navigationMenu: "Menu de navegação",
    openMenu: "Abrir menu",
    siteNavigation: "Navegação do site",
    mainNavigation: "Navegação principal",
    close: "Fechar",
    noContent: "Ainda não há conteúdo.",
    faqQuestions: "Perguntas: {heading}",
    previewShowing: "Prévia: conteúdo {status}",
    exitPreview: "Sair da prévia",
    by: "Por",
    other: "outro",
    others: "outros",
    draft: "rascunho",
    published: "publicado",
    archived: "arquivado",
  },
  nl: {
    homeLabel: "Home",
    siteLogo: "Sitelogo",
    footerNavigation: "Footernavigatie",
    rightsReserved: "Alle rechten voorbehouden.",
    checkingSession: "Sessie controleren",
    signIn: "Inloggen",
    loggedIn: "Ingelogd",
    signedInAs: "Ingelogd als",
    admin: "Beheer",
    signingOut: "Uitloggen…",
    logOut: "Uitloggen",
    navigationMenu: "Navigatiemenu",
    openMenu: "Menu openen",
    siteNavigation: "Sitenavigatie",
    mainNavigation: "Hoofdnavigatie",
    close: "Sluiten",
    noContent: "Nog geen inhoud.",
    faqQuestions: "Vragen: {heading}",
    previewShowing: "Voorbeeld: inhoud {status}",
    exitPreview: "Voorbeeld verlaten",
    by: "Door",
    other: "andere",
    others: "anderen",
    draft: "concept",
    published: "gepubliceerd",
    archived: "gearchiveerd",
  },
  sv: {
    homeLabel: "Hem",
    siteLogo: "Webbplatsens logotyp",
    footerNavigation: "Sidfotsnavigering",
    rightsReserved: "Alla rättigheter förbehållna.",
    checkingSession: "Kontrollerar sessionen",
    signIn: "Logga in",
    loggedIn: "Inloggad",
    signedInAs: "Inloggad som",
    admin: "Administration",
    signingOut: "Loggar ut…",
    logOut: "Logga ut",
    navigationMenu: "Navigeringsmeny",
    openMenu: "Öppna meny",
    siteNavigation: "Webbplatsnavigering",
    mainNavigation: "Huvudnavigering",
    close: "Stäng",
    noContent: "Inget innehåll ännu.",
    faqQuestions: "Frågor: {heading}",
    previewShowing: "Förhandsvisning: innehåll {status}",
    exitPreview: "Avsluta förhandsvisning",
    by: "Av",
    other: "annan",
    others: "andra",
    draft: "utkast",
    published: "publicerat",
    archived: "arkiverat",
  },
  pl: {
    homeLabel: "Strona główna",
    siteLogo: "Logo witryny",
    footerNavigation: "Nawigacja w stopce",
    rightsReserved: "Wszelkie prawa zastrzeżone.",
    checkingSession: "Sprawdzanie sesji",
    signIn: "Zaloguj się",
    loggedIn: "Zalogowano",
    signedInAs: "Zalogowano jako",
    admin: "Administracja",
    signingOut: "Wylogowywanie…",
    logOut: "Wyloguj się",
    navigationMenu: "Menu nawigacji",
    openMenu: "Otwórz menu",
    siteNavigation: "Nawigacja witryny",
    mainNavigation: "Nawigacja główna",
    close: "Zamknij",
    noContent: "Brak treści.",
    faqQuestions: "Pytania: {heading}",
    previewShowing: "Podgląd: treść {status}",
    exitPreview: "Zakończ podgląd",
    by: "Autorzy:",
    other: "inny",
    others: "innych",
    draft: "wersja robocza",
    published: "opublikowana",
    archived: "zarchiwizowana",
  },
  ru: {
    homeLabel: "Главная",
    siteLogo: "Логотип сайта",
    footerNavigation: "Навигация в подвале",
    rightsReserved: "Все права защищены.",
    checkingSession: "Проверка сеанса",
    signIn: "Войти",
    loggedIn: "Вход выполнен",
    signedInAs: "Вход выполнен как",
    admin: "Управление",
    signingOut: "Выход…",
    logOut: "Выйти",
    navigationMenu: "Меню навигации",
    openMenu: "Открыть меню",
    siteNavigation: "Навигация сайта",
    mainNavigation: "Основная навигация",
    close: "Закрыть",
    noContent: "Пока нет содержимого.",
    faqQuestions: "Вопросы: {heading}",
    previewShowing: "Предпросмотр: содержимое {status}",
    exitPreview: "Выйти из предпросмотра",
    by: "Авторы:",
    other: "другой",
    others: "других",
    draft: "черновик",
    published: "опубликовано",
    archived: "в архиве",
  },
  tr: {
    homeLabel: "Ana sayfa",
    siteLogo: "Site logosu",
    footerNavigation: "Alt bilgi gezinmesi",
    rightsReserved: "Tüm hakları saklıdır.",
    checkingSession: "Oturum kontrol ediliyor",
    signIn: "Giriş yap",
    loggedIn: "Giriş yapıldı",
    signedInAs: "Giriş yapan",
    admin: "Yönetim",
    signingOut: "Çıkış yapılıyor…",
    logOut: "Çıkış yap",
    navigationMenu: "Gezinme menüsü",
    openMenu: "Menüyü aç",
    siteNavigation: "Site gezinmesi",
    mainNavigation: "Ana gezinme",
    close: "Kapat",
    noContent: "Henüz içerik yok.",
    faqQuestions: "Sorular: {heading}",
    previewShowing: "Önizleme: içerik {status}",
    exitPreview: "Önizlemeden çık",
    by: "Yazan:",
    other: "diğer kişi",
    others: "diğer kişi",
    draft: "taslak",
    published: "yayımlandı",
    archived: "arşivlendi",
  },
  hi: {
    homeLabel: "मुखपृष्ठ",
    siteLogo: "साइट का लोगो",
    footerNavigation: "फ़ुटर नेविगेशन",
    rightsReserved: "सर्वाधिकार सुरक्षित।",
    checkingSession: "सत्र की जाँच हो रही है",
    signIn: "साइन इन करें",
    loggedIn: "साइन इन किया हुआ",
    signedInAs: "साइन इन किया है",
    admin: "प्रशासन",
    signingOut: "साइन आउट हो रहा है…",
    logOut: "साइन आउट करें",
    navigationMenu: "नेविगेशन मेनू",
    openMenu: "मेनू खोलें",
    siteNavigation: "साइट नेविगेशन",
    mainNavigation: "मुख्य नेविगेशन",
    close: "बंद करें",
    noContent: "अभी कोई सामग्री नहीं है।",
    faqQuestions: "प्रश्न: {heading}",
    previewShowing: "पूर्वावलोकन: सामग्री {status}",
    exitPreview: "पूर्वावलोकन से बाहर निकलें",
    by: "लेखक:",
    other: "अन्य",
    others: "अन्य",
    draft: "ड्राफ़्ट",
    published: "प्रकाशित",
    archived: "संग्रहित",
  },
  zh: {
    homeLabel: "首页",
    siteLogo: "网站标志",
    footerNavigation: "页脚导航",
    rightsReserved: "保留所有权利。",
    checkingSession: "正在检查会话",
    signIn: "登录",
    loggedIn: "已登录",
    signedInAs: "登录用户",
    admin: "管理",
    signingOut: "正在退出…",
    logOut: "退出登录",
    navigationMenu: "导航菜单",
    openMenu: "打开菜单",
    siteNavigation: "网站导航",
    mainNavigation: "主导航",
    close: "关闭",
    noContent: "暂无内容。",
    faqQuestions: "问题：{heading}",
    previewShowing: "预览：内容 {status}",
    exitPreview: "退出预览",
    by: "作者：",
    other: "位其他作者",
    others: "位其他作者",
    draft: "草稿",
    published: "已发布",
    archived: "已归档",
  },
  ja: {
    homeLabel: "ホーム",
    siteLogo: "サイトのロゴ",
    footerNavigation: "フッターナビゲーション",
    rightsReserved: "無断転載を禁じます。",
    checkingSession: "セッションを確認中",
    signIn: "ログイン",
    loggedIn: "ログイン済み",
    signedInAs: "ログイン中のユーザー",
    admin: "管理",
    signingOut: "ログアウト中…",
    logOut: "ログアウト",
    navigationMenu: "ナビゲーションメニュー",
    openMenu: "メニューを開く",
    siteNavigation: "サイトナビゲーション",
    mainNavigation: "メインナビゲーション",
    close: "閉じる",
    noContent: "まだコンテンツがありません。",
    faqQuestions: "質問：{heading}",
    previewShowing: "プレビュー：コンテンツ {status}",
    exitPreview: "プレビューを終了",
    by: "著者：",
    other: "人の他の著者",
    others: "人の他の著者",
    draft: "下書き",
    published: "公開済み",
    archived: "アーカイブ済み",
  },
  ko: {
    homeLabel: "홈",
    siteLogo: "사이트 로고",
    footerNavigation: "바닥글 탐색",
    rightsReserved: "모든 권리 보유.",
    checkingSession: "세션 확인 중",
    signIn: "로그인",
    loggedIn: "로그인됨",
    signedInAs: "로그인 사용자",
    admin: "관리",
    signingOut: "로그아웃 중…",
    logOut: "로그아웃",
    navigationMenu: "탐색 메뉴",
    openMenu: "메뉴 열기",
    siteNavigation: "사이트 탐색",
    mainNavigation: "기본 탐색",
    close: "닫기",
    noContent: "아직 콘텐츠가 없습니다.",
    faqQuestions: "질문: {heading}",
    previewShowing: "미리보기: 콘텐츠 {status}",
    exitPreview: "미리보기 종료",
    by: "작성자:",
    other: "명의 다른 작성자",
    others: "명의 다른 작성자",
    draft: "초안",
    published: "게시됨",
    archived: "보관됨",
  },
} satisfies Record<SupportedLocale, PublicChrome>

export const PUBLIC_MESSAGES = {
  en: {
    chrome: PUBLIC_CHROME["en"],
    notFound: {
      title: "Page not found",
      body: "The page you are looking for does not exist or has been moved.",
    },
    error: {
      eyebrow: "Error",
      title: "Something went wrong",
      body: "An unexpected error occurred. Please try again or return to the home page.",
      retry: "Try again",
    },
    home: "Return home",
    loading: "Loading page content",
    languageSwitcher: {
      label: "Change language",
      checking: "Checking…",
      unavailable: "Not available",
    },
  },
  fr: {
    chrome: PUBLIC_CHROME["fr"],
    notFound: {
      title: "Page introuvable",
      body: "La page que vous recherchez n'existe pas ou a été déplacée.",
    },
    error: {
      eyebrow: "Erreur",
      title: "Une erreur s'est produite",
      body: "Une erreur inattendue s'est produite. Veuillez réessayer ou revenir à la page d'accueil.",
      retry: "Réessayer",
    },
    home: "Retour à l'accueil",
    loading: "Chargement du contenu de la page",
    languageSwitcher: {
      label: "Changer de langue",
      checking: "Vérification…",
      unavailable: "Non disponible",
    },
  },
  es: {
    chrome: PUBLIC_CHROME["es"],
    notFound: {
      title: "Página no encontrada",
      body: "La página que buscas no existe o se ha movido.",
    },
    error: {
      eyebrow: "Error",
      title: "Algo salió mal",
      body: "Se produjo un error inesperado. Inténtalo de nuevo o vuelve a la página de inicio.",
      retry: "Intentar de nuevo",
    },
    home: "Volver al inicio",
    loading: "Cargando el contenido de la página",
    languageSwitcher: {
      label: "Cambiar idioma",
      checking: "Comprobando…",
      unavailable: "No disponible",
    },
  },
  it: {
    chrome: PUBLIC_CHROME["it"],
    notFound: {
      title: "Pagina non trovata",
      body: "La pagina che stai cercando non esiste o è stata spostata.",
    },
    error: {
      eyebrow: "Errore",
      title: "Qualcosa è andato storto",
      body: "Si è verificato un errore imprevisto. Riprova o torna alla pagina iniziale.",
      retry: "Riprova",
    },
    home: "Torna alla pagina iniziale",
    loading: "Caricamento del contenuto della pagina",
    languageSwitcher: {
      label: "Cambia lingua",
      checking: "Verifica in corso…",
      unavailable: "Non disponibile",
    },
  },
  pt: {
    chrome: PUBLIC_CHROME["pt"],
    notFound: {
      title: "Página não encontrada",
      body: "A página que procura não existe ou foi movida.",
    },
    error: {
      eyebrow: "Erro",
      title: "Algo correu mal",
      body: "Ocorreu um erro inesperado. Tente novamente ou volte à página inicial.",
      retry: "Tentar novamente",
    },
    home: "Voltar à página inicial",
    loading: "A carregar o conteúdo da página",
    languageSwitcher: {
      label: "Mudar de idioma",
      checking: "A verificar…",
      unavailable: "Indisponível",
    },
  },
  "pt-br": {
    chrome: PUBLIC_CHROME["pt-br"],
    notFound: {
      title: "Página não encontrada",
      body: "A página que você procura não existe ou foi movida.",
    },
    error: {
      eyebrow: "Erro",
      title: "Algo deu errado",
      body: "Ocorreu um erro inesperado. Tente novamente ou volte para a página inicial.",
      retry: "Tentar novamente",
    },
    home: "Voltar para a página inicial",
    loading: "Carregando o conteúdo da página",
    languageSwitcher: {
      label: "Mudar idioma",
      checking: "Verificando…",
      unavailable: "Indisponível",
    },
  },
  nl: {
    chrome: PUBLIC_CHROME["nl"],
    notFound: {
      title: "Pagina niet gevonden",
      body: "De pagina die u zoekt bestaat niet of is verplaatst.",
    },
    error: {
      eyebrow: "Fout",
      title: "Er is iets misgegaan",
      body: "Er is een onverwachte fout opgetreden. Probeer het opnieuw of ga terug naar de startpagina.",
      retry: "Opnieuw proberen",
    },
    home: "Terug naar de startpagina",
    loading: "Pagina-inhoud wordt geladen",
    languageSwitcher: {
      label: "Taal wijzigen",
      checking: "Controleren…",
      unavailable: "Niet beschikbaar",
    },
  },
  sv: {
    chrome: PUBLIC_CHROME["sv"],
    notFound: {
      title: "Sidan hittades inte",
      body: "Sidan du letar efter finns inte eller har flyttats.",
    },
    error: {
      eyebrow: "Fel",
      title: "Något gick fel",
      body: "Ett oväntat fel inträffade. Försök igen eller gå tillbaka till startsidan.",
      retry: "Försök igen",
    },
    home: "Tillbaka till startsidan",
    loading: "Läser in sidans innehåll",
    languageSwitcher: {
      label: "Byt språk",
      checking: "Kontrollerar…",
      unavailable: "Inte tillgänglig",
    },
  },
  pl: {
    chrome: PUBLIC_CHROME["pl"],
    notFound: {
      title: "Nie znaleziono strony",
      body: "Strona, której szukasz, nie istnieje lub została przeniesiona.",
    },
    error: {
      eyebrow: "Błąd",
      title: "Coś poszło nie tak",
      body: "Wystąpił nieoczekiwany błąd. Spróbuj ponownie lub wróć na stronę główną.",
      retry: "Spróbuj ponownie",
    },
    home: "Wróć na stronę główną",
    loading: "Wczytywanie zawartości strony",
    languageSwitcher: {
      label: "Zmień język",
      checking: "Sprawdzanie…",
      unavailable: "Niedostępne",
    },
  },
  ru: {
    chrome: PUBLIC_CHROME["ru"],
    notFound: {
      title: "Страница не найдена",
      body: "Страница, которую вы ищете, не существует или была перемещена.",
    },
    error: {
      eyebrow: "Ошибка",
      title: "Что-то пошло не так",
      body: "Произошла непредвиденная ошибка. Попробуйте ещё раз или вернитесь на главную страницу.",
      retry: "Попробовать ещё раз",
    },
    home: "Вернуться на главную",
    loading: "Загрузка содержимого страницы",
    languageSwitcher: {
      label: "Сменить язык",
      checking: "Проверка…",
      unavailable: "Недоступно",
    },
  },
  tr: {
    chrome: PUBLIC_CHROME["tr"],
    notFound: {
      title: "Sayfa bulunamadı",
      body: "Aradığınız sayfa mevcut değil veya taşınmış.",
    },
    error: {
      eyebrow: "Hata",
      title: "Bir şeyler ters gitti",
      body: "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin veya ana sayfaya dönün.",
      retry: "Tekrar dene",
    },
    home: "Ana sayfaya dön",
    loading: "Sayfa içeriği yükleniyor",
    languageSwitcher: {
      label: "Dili değiştir",
      checking: "Kontrol ediliyor…",
      unavailable: "Kullanılamıyor",
    },
  },
  hi: {
    chrome: PUBLIC_CHROME["hi"],
    notFound: {
      title: "पृष्ठ नहीं मिला",
      body: "आप जिस पृष्ठ को खोज रहे हैं, वह मौजूद नहीं है या उसे कहीं और ले जाया गया है।",
    },
    error: {
      eyebrow: "त्रुटि",
      title: "कुछ गलत हो गया",
      body: "एक अनपेक्षित त्रुटि हुई। कृपया फिर से प्रयास करें या मुखपृष्ठ पर लौटें।",
      retry: "फिर से प्रयास करें",
    },
    home: "मुखपृष्ठ पर लौटें",
    loading: "पृष्ठ की सामग्री लोड हो रही है",
    languageSwitcher: {
      label: "भाषा बदलें",
      checking: "जाँच हो रही है…",
      unavailable: "उपलब्ध नहीं",
    },
  },
  zh: {
    chrome: PUBLIC_CHROME["zh"],
    notFound: {
      title: "找不到页面",
      body: "您要查找的页面不存在或已被移动。",
    },
    error: {
      eyebrow: "错误",
      title: "出现问题",
      body: "发生了意外错误。请重试或返回首页。",
      retry: "重试",
    },
    home: "返回首页",
    loading: "正在加载页面内容",
    languageSwitcher: {
      label: "切换语言",
      checking: "正在检查…",
      unavailable: "不可用",
    },
  },
  ja: {
    chrome: PUBLIC_CHROME["ja"],
    notFound: {
      title: "ページが見つかりません",
      body: "お探しのページは存在しないか、移動された可能性があります。",
    },
    error: {
      eyebrow: "エラー",
      title: "問題が発生しました",
      body: "予期しないエラーが発生しました。もう一度お試しいただくか、ホームページに戻ってください。",
      retry: "もう一度試す",
    },
    home: "ホームに戻る",
    loading: "ページの内容を読み込んでいます",
    languageSwitcher: {
      label: "言語を変更",
      checking: "確認中…",
      unavailable: "利用できません",
    },
  },
  ko: {
    chrome: PUBLIC_CHROME["ko"],
    notFound: {
      title: "페이지를 찾을 수 없습니다",
      body: "찾으시는 페이지가 존재하지 않거나 이동되었습니다.",
    },
    error: {
      eyebrow: "오류",
      title: "문제가 발생했습니다",
      body: "예기치 않은 오류가 발생했습니다. 다시 시도하거나 홈페이지로 돌아가세요.",
      retry: "다시 시도",
    },
    home: "홈으로 돌아가기",
    loading: "페이지 콘텐츠를 불러오는 중",
    languageSwitcher: {
      label: "언어 변경",
      checking: "확인 중…",
      unavailable: "사용할 수 없음",
    },
  },
} as const satisfies Record<SupportedLocale, PublicMessages>

/**
 * Copy for one presentation locale. Enabled locales are always catalog
 * locales, so the fallback is reachable only for a hand-edited settings row.
 */
export function getPublicMessages(locale: string): PublicMessages {
  return (
    (PUBLIC_MESSAGES as Record<string, PublicMessages>)[locale] ??
    PUBLIC_MESSAGES[FALLBACK_LOCALE as SupportedLocale]
  )
}

export const PUBLIC_PREVIEW_FALLBACK = {
  en: {
    body: "This page is not available in {locale}. Showing the {defaultLocale} version.",
  },
  fr: {
    body: "Cette page n’est pas disponible en {locale}. La version en {defaultLocale} s’affiche.",
  },
  es: {
    body: "Esta página no está disponible en {locale}. Se muestra la versión en {defaultLocale}.",
  },
  it: {
    body: "Questa pagina non è disponibile in {locale}. Viene mostrata la versione in {defaultLocale}.",
  },
  pt: {
    body: "Esta página não está disponível em {locale}. É apresentada a versão em {defaultLocale}.",
  },
  "pt-br": {
    body: "Esta página não está disponível em {locale}. Exibindo a versão em {defaultLocale}.",
  },
  nl: {
    body: "Deze pagina is niet beschikbaar in {locale}. De versie in {defaultLocale} wordt getoond.",
  },
  sv: {
    body: "Den här sidan finns inte på {locale}. Visar versionen på {defaultLocale}.",
  },
  pl: {
    body: "Ta strona nie jest dostępna w języku {locale}. Wyświetlam wersję w języku {defaultLocale}.",
  },
  ru: {
    body: "Эта страница недоступна на языке {locale}. Показана версия на языке {defaultLocale}.",
  },
  tr: {
    body: "Bu sayfa {locale} dilinde mevcut değil. {defaultLocale} sürümü gösteriliyor.",
  },
  hi: {
    body: "यह पृष्ठ {locale} में उपलब्ध नहीं है। {defaultLocale} वाला संस्करण दिखाया जा रहा है।",
  },
  zh: {
    body: "此页面暂无{locale}版本。当前显示{defaultLocale}版本。",
  },
  ja: {
    body: "このページは{locale}では表示できません。{defaultLocale}版を表示しています。",
  },
  ko: {
    body: "이 페이지는 {locale}로 제공되지 않습니다. {defaultLocale} 버전을 표시합니다.",
  },
} as const satisfies Record<SupportedLocale, { body: string }>

function localizedLanguageLabel(code: string, displayLocale: string): string {
  try {
    return (
      new Intl.DisplayNames([displayLocale], { type: "language" }).of(code) ??
      code
    )
  } catch {
    return code
  }
}

export function getPublicPreviewFallback(
  locale: string,
  defaultLocale: string
): string {
  const copy =
    (PUBLIC_PREVIEW_FALLBACK as Record<string, { body: string }>)[locale] ??
    PUBLIC_PREVIEW_FALLBACK[FALLBACK_LOCALE as SupportedLocale]
  return copy.body
    .replaceAll("{locale}", localizedLanguageLabel(locale, locale))
    .replaceAll(
      "{defaultLocale}",
      localizedLanguageLabel(defaultLocale, locale)
    )
}
