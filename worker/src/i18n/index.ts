import { LocaleMessages } from "./type";
import zh from "./zh";
import en from "./en";
import id from "./id";
import { Context } from "hono";

/**
 * Merge a locale's messages with `en` as fallback so that any key missing
 * from the requested locale resolves to the English string.
 */
function withFallback(locale: Partial<LocaleMessages>): LocaleMessages {
    return { ...en, ...locale };
}

export default {
    getMessages: (
        locale: string | null | undefined
    ): LocaleMessages => {
        // multi-language support
        if (locale === "en") return en;
        if (locale === "zh") return withFallback(zh);
        if (locale === "id") return withFallback(id);

        // fallback language
        return en;
    },
    getMessagesbyContext: (
        c: Context<HonoCustomType>
    ): LocaleMessages => {
        const locale = c?.get?.("lang") || c.env?.DEFAULT_LANG;
        // multi-language support
        if (locale === "en") return en;
        if (locale === "zh") return withFallback(zh);
        if (locale === "id") return withFallback(id);

        // fallback language
        return en;
    }
}
