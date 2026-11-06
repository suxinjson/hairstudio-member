<template>
  <div class="space-y-6 max-w-4xl mx-auto pb-12">
    <!-- 顶栏标题与操作 -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-700 flex items-center justify-center text-2xl shadow-inner shrink-0">
          📢
        </div>
        <div>
          <h2 class="text-lg font-black text-slate-900">语音播报服务配置</h2>
          <p class="text-xs text-slate-400 mt-0.5">支持讯飞、Fish Audio 与 HeyGen，收银结算与会员充值自动语音到账提示</p>
        </div>
      </div>

      <!-- 全局启用开关 -->
      <div class="flex items-center gap-3 bg-slate-50 px-4 py-2.5 rounded-xl border border-slate-200">
        <span class="text-xs font-bold text-slate-700">播报总开关</span>
        <button
          type="button"
          :disabled="!isOwner || !loaded || isLoading || isSaving"
          role="switch" :aria-checked="form.enabled" aria-label="播报总开关"
          @click="toggleEnabled"
          class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50"
          :class="form.enabled ? 'bg-emerald-600' : 'bg-slate-300'"
        >
          <span
            class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out"
            :class="form.enabled ? 'translate-x-5' : 'translate-x-0'"
          />
        </button>
        <span class="text-xs font-black" :class="form.enabled ? 'text-emerald-700' : 'text-slate-400'">
          {{ form.enabled ? '已开启' : '已停用' }}
        </span>
      </div>
    </div>

    <!-- 权限提示 (非店主) -->
    <div v-if="!isOwner" class="p-4 bg-amber-50 text-amber-900 rounded-2xl border border-amber-200 text-xs font-bold flex items-center gap-2">
      <span>🔒</span> 提示：您当前以收银员/店员身份登录，仅支持查看与播放已启用的播报。修改语音播报配置需店主权限。
    </div>

    <!-- 消息提示栏 -->
    <div v-if="message" class="p-4 rounded-2xl text-xs font-bold transition flex items-center justify-between"
      :class="messageType === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-200'">
      <div class="flex items-center gap-2">
        <span>{{ messageType === 'success' ? '✅' : '⚠️' }}</span>
        <span>{{ message }}</span>
      </div>
      <button @click="message = ''" class="text-slate-400 hover:text-slate-600">✕</button>
    </div>

    <p v-if="isLoading" role="status" class="p-4 text-sm text-slate-600">正在加载门店语音配置…</p>
    <button v-if="!loaded && !isLoading" type="button" @click="loadConfig" class="rounded-xl border p-3 font-bold">重新加载语音配置</button>
    <fieldset v-if="loaded" :disabled="isSaving" class="contents">
    <!-- 1. 服务商选择 -->
    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-black text-slate-800 flex items-center gap-2">
          <span>1. 选择 TTS 语音合成服务引擎</span>
        </h3>
        <span class="text-[11px] text-slate-400 font-medium">国内服务器推荐选择讯飞</span>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button type="button" @click="selectProvider('xfyun')" :disabled="!isOwner"
          class="p-4 rounded-xl border-2 transition text-left disabled:opacity-60"
          :class="form.provider === 'xfyun' ? 'border-emerald-600 bg-emerald-50/40 shadow-sm' : 'border-slate-200 hover:border-slate-300 bg-slate-50/50'">
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm font-black text-slate-900">讯飞在线语音</span>
            <span v-if="form.provider === 'xfyun'" class="text-xs bg-emerald-600 text-white font-black px-2 py-0.5 rounded-full">当前生效</span>
          </div>
          <p class="text-xs text-slate-500 leading-relaxed">中文收银播报，支持小燕等基础发音人；免费服务量以讯飞控制台为准。</p>
        </button>
        <!-- Fish Audio 卡片 -->
        <div
          @click="selectProvider('fish_audio')"
          class="p-4 rounded-xl border-2 transition cursor-pointer relative"
          :class="form.provider === 'fish_audio' ? 'border-emerald-600 bg-emerald-50/40 shadow-sm' : 'border-slate-200 hover:border-slate-300 bg-slate-50/50'"
        >
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <span class="text-2xl">🐟</span>
              <div>
                <div class="text-sm font-black text-slate-900">Fish Audio</div>
                <div class="text-[10px] text-slate-400">api.fish.audio / v1 / tts</div>
              </div>
            </div>
            <span v-if="form.provider === 'fish_audio'" class="text-xs bg-emerald-600 text-white font-black px-2 py-0.5 rounded-full">当前生效</span>
          </div>
          <p class="text-xs text-slate-500 leading-relaxed">
            极速流式返回 MP3 二进制音频，低延迟，人声自然流畅，支持丰富音色克隆模型。
          </p>
        </div>

        <!-- HeyGen 卡片 -->
        <div
          @click="selectProvider('heygen')"
          class="p-4 rounded-xl border-2 transition cursor-pointer relative"
          :class="form.provider === 'heygen' ? 'border-emerald-600 bg-emerald-50/40 shadow-sm' : 'border-slate-200 hover:border-slate-300 bg-slate-50/50'"
        >
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <span class="text-2xl">🤖</span>
              <div>
                <div class="text-sm font-black text-slate-900">HeyGen</div>
                <div class="text-[10px] text-slate-400">api.heygen.com / v3 / audio</div>
              </div>
            </div>
            <span v-if="form.provider === 'heygen'" class="text-xs bg-emerald-600 text-white font-black px-2 py-0.5 rounded-full">当前生效</span>
          </div>
          <p class="text-xs text-slate-500 leading-relaxed">
            国际知名 AI 语音引擎，通过 X-Api-Key 鉴权，支持情感表达与高品质 WAV 音频生成。
          </p>
        </div>
      </div>
    </div>

    <!-- 2. API 凭据与模型参数设置 -->
    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-black text-slate-800 flex items-center gap-2">
          <span>2. {{ providerName }} 接口参数设置</span>
        </h3>

      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- API URL -->
        <div class="md:col-span-2 space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-bold text-slate-700">API 接口地址 (URL)</label>
            <button
              v-if="isOwner"
              type="button"
              @click="resetDefaultUrl"
              class="text-[11px] text-slate-500 hover:text-emerald-700 underline font-medium"
            >
              恢复默认地址
            </button>
          </div>
          <input
            v-model="form.apiUrl"
            :disabled="!isOwner"
            type="text"
            :placeholder="defaultUrl"
            class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono focus:outline-none focus:border-emerald-600 disabled:opacity-60"
          />
        </div>

        <!-- API Key -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-bold text-slate-700">
              {{ form.provider === 'xfyun' ? 'APIPassword（鉴权信息）' : 'API Key 凭据' }}
              <span v-if="hasCurrentProviderKey" class="ml-1 text-[10px] text-emerald-700 font-bold bg-emerald-100 px-1.5 py-0.5 rounded">云端已配置</span>
            </label>
            <button
              type="button"
              @click="showKey = !showKey"
              class="text-[11px] text-slate-500 hover:text-slate-800 font-medium"
            >
              {{ showKey ? '隐藏' : '显示' }}
            </button>
          </div>
          <div class="relative">
            <input
              v-model="form.apiKey"
              :disabled="!isOwner"
              :type="showKey ? 'text' : 'password'"
              :placeholder="hasCurrentProviderKey ? '云端已配置 (留空表示不修改)' : (form.provider === 'xfyun' ? '填写鉴权信息中的 ak-… 密钥' : '请输入当前服务商的 API Key')"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono focus:outline-none focus:border-emerald-600 disabled:opacity-60"
            />
          </div>
          <p class="text-[10px] text-slate-400">
            {{ form.provider === 'xfyun' ? '使用控制台“鉴权信息”中的 APIPassword；留空可使用服务器配置。' : (form.provider === 'fish_audio' ? '通过 Authorization: Bearer 鉴权' : '通过 X-Api-Key 请求头鉴权') }}
          </p>
        </div>

        <!-- Model 模型名称 -->
        <div v-if="form.provider !== 'xfyun'" class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-bold text-slate-700">模型标识 (Model)</label>
            <button
              v-if="isOwner"
              type="button"
              @click="resetDefaultModel"
              class="text-[11px] text-slate-500 hover:text-emerald-700 underline font-medium"
            >
              恢复默认
            </button>
          </div>
          <input
            v-model="form.model"
            :disabled="!isOwner"
            type="text"
            :placeholder="defaultModel"
            class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono focus:outline-none focus:border-emerald-600 disabled:opacity-60"
          />
          <p class="text-[10px] text-slate-400">
            {{ form.provider === 'fish_audio' ? '在 HTTP 请求头 model 中传递' : '在 JSON 请求体 model 中传递' }}
          </p>
        </div>
        <div v-else class="space-y-1.5">
          <label class="text-xs font-bold text-slate-700">讯飞 APPID</label>
          <input v-model="form.appId" :disabled="!isOwner" type="text" placeholder="控制台的 APPID"
            class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono focus:outline-none focus:border-emerald-600 disabled:opacity-60" />
          <p class="text-[10px] text-slate-400">使用已开通在线语音合成的应用。</p>
        </div>

        <!-- Voice ID / Reference ID -->
        <div class="md:col-span-2 space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-bold text-slate-700">
              {{ form.provider === 'xfyun' ? '讯飞发音人 (vcn)' : (form.provider === 'fish_audio' ? '参考音色 ID (reference_id)' : '音色 ID (voice_id)') }}
            </label>
            <button
              v-if="isOwner"
              type="button"
              @click="resetDefaultVoiceId"
              class="text-[11px] text-slate-500 hover:text-emerald-700 underline font-medium"
            >
              恢复默认
            </button>
          </div>
          <select v-if="form.provider === 'xfyun'" v-model="form.voiceId" :disabled="!isOwner"
            class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:outline-none focus:border-emerald-600 disabled:opacity-60">
            <option value="x4_xiaoyan">讯飞小燕 · 普通话</option>
            <option value="x4_yezi">讯飞小露 · 普通话</option>
            <option value="aisjiuxu">讯飞许久 · 普通话</option>
            <option value="aisjinger">讯飞小婧 · 普通话</option>
            <option value="aisbabyxu">讯飞许小宝 · 普通话</option>
          </select>
          <input v-else
            v-model="form.voiceId"
            :disabled="!isOwner"
            type="text"
            :placeholder="defaultVoiceId"
            class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono focus:outline-none focus:border-emerald-600 disabled:opacity-60"
          />
          <p class="text-[10px] text-slate-400">
            指定用于发音的声音角色编号（可在服务商控制台获取）
          </p>
        </div>
      </div>
    </div>

    <!-- 3. 播报文案模板 -->
    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-black text-slate-800 flex items-center gap-2">
          <span>3. 业务播报文案模板</span>
        </h3>
        <span class="text-[11px] text-slate-400 font-medium">支持变量：{name} 姓名、{amount} 金额、{balance} 余额</span>
      </div>

      <div class="space-y-4">
        <!-- 消费扣款模板 -->
        <div class="space-y-1.5">
          <label class="flex items-center gap-2 text-sm font-bold"><input type="checkbox" v-model="form.events.consume" :disabled="!isOwner" aria-label="消费播报开关">消费成功后播报</label>
          <div class="flex items-center justify-between">
            <label class="text-xs font-bold text-slate-700">会员消费扣款播报文案</label>
            <div class="flex flex-wrap gap-1.5">
              <button
                type="button"
                v-for="v in ['{name}', '{amount}', '{balance}']"
                :key="v"
                @click="insertVar('consume', v)"
                class="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded text-[11px] font-mono transition"
              >
                +{{ v }}
              </button>
            </div>
          </div>
          <input
            v-model="form.templates.consume"
            aria-label="消费播报语句" maxlength="200"
            :disabled="!isOwner"
            type="text"
            class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold focus:outline-none focus:border-emerald-600 disabled:opacity-60"
          />
        </div>

        <!-- 充值成功模板 -->
        <div class="space-y-1.5">
          <label class="flex items-center gap-2 text-sm font-bold"><input type="checkbox" v-model="form.events.recharge" :disabled="!isOwner" aria-label="充值播报开关">充值成功后播报</label>
          <div class="flex items-center justify-between">
            <label class="text-xs font-bold text-slate-700">会员充值到账播报文案</label>
            <div class="flex flex-wrap gap-1.5">
              <button
                type="button"
                v-for="v in ['{name}', '{amount}', '{balance}', '{gift}', '{totalCredit}']"
                :key="v"
                @click="insertVar('recharge', v)"
                class="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded text-[11px] font-mono transition"
              >
                +{{ v }}
              </button>
            </div>
          </div>
          <input
            v-model="form.templates.recharge"
            aria-label="充值播报语句" maxlength="200"
            :disabled="!isOwner"
            type="text"
            class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold focus:outline-none focus:border-emerald-600 disabled:opacity-60"
          />
        </div>
        <p class="text-xs text-slate-500">充值的 {amount} 为实付金额，{gift} 为赠送金额，{totalCredit} 为合计入账。关闭对应开关即可暂停该类播报。</p>
      </div>
    </div>

    <!-- 4. 试听测试与音量控制 -->
    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-black text-slate-800 flex items-center gap-2">
          <span>4. 实时试听测试与音量调节</span>
        </h3>
        <div class="flex items-center gap-2">
          <span class="text-xs text-slate-500 font-bold">音量: {{ Math.round(form.volume * 100) }}%</span>
          <input
            v-model.number="form.volume"
            aria-label="播报音量" :disabled="!isOwner"
            type="range"
            min="0.1"
            max="1.0"
            step="0.05"
            class="w-24 accent-emerald-600 cursor-pointer"
          />
        </div>
      </div>

      <div class="space-y-3">
        <div class="flex flex-col sm:flex-row gap-3">
          <input
            v-model="testText"
            type="text"
            placeholder="输入需要试听的测试文本..."
            class="flex-1 h-11 px-3 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold focus:outline-none focus:border-emerald-600"
            @keyup.enter="handleTestPlay"
          />
          <button
            type="button"
            :disabled="testStatus !== 'idle' || !testText.trim()"
            @click="handleTestPlay"
            class="h-11 px-6 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-black transition flex items-center justify-center gap-2 shadow-md shadow-emerald-900/20 disabled:opacity-50 shrink-0"
          >
            <span v-if="testStatus === 'synthesizing'" class="animate-spin text-sm">⏳</span>
            <span v-else-if="testStatus === 'playing'" class="animate-pulse text-sm">🔊</span>
            <span v-else>▶</span>
            <span>{{ testStatus === 'synthesizing' ? '合成中...' : (testStatus === 'playing' ? '正在播放中' : '试听测试') }}</span>
          </button>
          <button
            v-if="testStatus !== 'idle'"
            type="button"
            @click="handleStopPlay"
            class="h-11 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition shrink-0"
          >
            ⏹ 停止
          </button>
        </div>

        <!-- 本区即时状态与错误反馈 -->
        <div
          v-if="testMessage"
          class="p-3 rounded-xl text-xs font-bold transition flex items-center justify-between"
          :class="testMessageType === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-200'"
        >
          <div class="flex items-center gap-2">
            <span>{{ testMessageType === 'success' ? '✅' : '⚠️' }}</span>
            <span>{{ testMessage }}</span>
          </div>
          <button type="button" @click="testMessage = ''" class="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <p class="text-[11px] text-slate-400">
          💡 点击试听测试将实时调用后端合成接口验证当前的 API Key、服务商与音色 ID，确认生效后点击下方保存。
        </p>
      </div>
    </div>

    <section v-if="isOwner" class="bg-white p-6 rounded-2xl border border-slate-200 space-y-4">
      <h3 class="font-bold text-slate-900">天猫精灵语音记账</h3>
      <p class="text-xs text-slate-500">通过已校验平台身份的签名网关接入。启用前请配置记账账号、设备和新的随机签名密钥。</p>
      <p v-if="webhookUrl" class="text-xs break-all">服务接口：<code>{{ webhookUrl }}</code><button type="button" @click="copyValue(webhookUrl, '接口地址')" class="ml-2 text-emerald-700">复制接口地址</button></p>
      <label class="flex gap-2 text-sm"><input type="checkbox" v-model="ali.enabled" aria-label="天猫精灵开关">启用语音查询与记账</label>
      <label class="block text-sm">记账账号
        <select v-model="ali.actorId" aria-label="天猫精灵记账账号" class="block w-full border rounded-lg p-2 mt-1">
          <option value="">请选择在用店主或收银员</option>
          <option v-for="user in voiceActors" :key="user.id" :value="user.id">{{ user.displayName }}（{{ user.role === 'owner' ? '店主' : '收银员' }}）</option>
        </select>
      </label>
      <label class="block text-sm">签名密钥
        <input type="password" v-model="ali.token" aria-label="天猫精灵签名密钥" autocomplete="new-password" maxlength="100" :placeholder="aliHasToken ? '已配置；留空保留' : '32–100 位随机字符'" class="block w-full border rounded-lg p-2 mt-1">
      </label>
      <button type="button" @click="generateSigningSecret" class="text-sm text-emerald-700">生成新签名密钥</button>
      <p v-if="generatedSecret" class="text-xs break-all">请复制到签名网关后保存：<code>{{ generatedSecret }}</code></p>
      <button v-if="generatedSecret" type="button" @click="copyValue(generatedSecret, '签名密钥')" class="text-sm text-emerald-700">复制签名密钥</button>
      <label class="block text-sm">允许的设备标识（每行一个）
        <textarea v-model="aliDevices" aria-label="天猫精灵设备白名单" rows="3" class="block w-full border rounded-lg p-2 mt-1" />
      </label>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label class="block text-sm">平台域名校验文件名
          <input type="text" v-model="ali.verificationFile" maxlength="100" placeholder="例如 b3e0f13ccb082b486a3c85c834b6598a.txt" class="block w-full border rounded-lg p-2 mt-1 text-xs">
        </label>
        <label class="block text-sm">平台域名校验文件内容
          <input type="text" v-model="ali.verificationContent" maxlength="200" placeholder="校验文本内容（直接保存在数据库中）" class="block w-full border rounded-lg p-2 mt-1 text-xs">
        </label>
      </div>
      <p class="text-xs text-slate-500">保存后还需在天猫精灵开放平台配置技能、意图和接口。平台网页试听缺少真实设备身份时只验证对话，实际记账请使用白名单内的音箱。</p>
    </section>

    <!-- 底部保存按钮 -->
    <div v-if="isOwner" class="flex justify-end gap-3 pt-2">
      <button
        type="button"
        @click="loadConfig"
        :disabled="isSaving"
        class="h-11 px-5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition disabled:opacity-50"
      >
        取消修改
      </button>
      <button
        type="button"
        @click="handleSave"
        :disabled="isSaving"
        class="h-11 px-8 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-black transition shadow-lg shadow-emerald-900/30 flex items-center gap-2 disabled:opacity-50"
      >
        <span v-if="isSaving" class="animate-spin">⏳</span>
        <span>{{ isSaving ? '保存中...' : '保存播报配置' }}</span>
      </button>
    </div>
    </fieldset>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
const props = defineProps({
  api: { type: Object, required: true },
  player: { type: Object, required: true },
  user: { type: Object, default: null },
  serverUrl: { type: String, default: () => globalThis.location?.origin || '' },
  copyText: { type: Function, default: text => navigator.clipboard.writeText(text) }
});
const emit = defineEmits(['saved']);

const DEFAULTS = {
  xfyun: { apiUrl: 'wss://tts-api.xfyun.cn/v2/tts', model: '', voiceId: 'x4_xiaoyan', appId: '' },
  fish_audio: {
    apiUrl: 'https://api.fish.audio/v1/tts',
    model: 's2.1-pro-free',
    voiceId: '74c6aba5cbf94a15bbdc547ffce5cb38'
  },
  heygen: {
    apiUrl: 'https://api.heygen.com/v3/models/audio/tts',
    model: 'heygen-voice-1-turbo-free',
    voiceId: '83548de556df48ba8c09c42a57c51d85'
  }
};

const isOwner = computed(() => props.user?.role === 'owner');
const webhookUrl = computed(() => props.serverUrl ? props.serverUrl + '/api/v1/voice/aligenie' : '');
const loaded = ref(false), isLoading = ref(false);
let alive = true, loadSequence = 0, tipTimer = null, previewSequence = 0;

const form = reactive({
  enabled: false,
  provider: 'fish_audio',
  apiUrl: '',
  apiKey: '',
  appId: '',
  model: '',
  voiceId: '',
  volume: 1.0,
  events: { consume: true, recharge: true },
  templates: {
    consume: '{name} 消费 {amount} 元，卡内余额 {balance} 元',
    recharge: '{name} 充值 {amount} 元，卡内余额 {balance} 元'
  }
});

const ali = reactive({ enabled: false, actorId: '', token: '', verificationFile: '', verificationContent: '' });
const aliDevices = ref('');
const aliHasToken = ref(false);
const generatedSecret = ref('');
const voiceActors = ref([]);
function generateSigningSecret() {
  if (!isOwner.value || !loaded.value || isSaving.value) return;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  generatedSecret.value = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  ali.token = generatedSecret.value;
}

async function copyValue(value, label) {
  try { await props.copyText(value); if (alive) showTip(label + '已复制'); }
  catch (error) { if (alive) showTip(error.message || '复制失败，请重试', 'error'); }
}

const hasSavedKey = ref(false);
const savedKeyProvider = ref('');
const serverXfyunConfigured = ref(false);
const serverXfyunAppId = ref('');
const hasCurrentProviderKey = computed(() => (hasSavedKey.value && savedKeyProvider.value === form.provider) || (form.provider === 'xfyun' && serverXfyunConfigured.value));
const providerName = computed(() => ({ fish_audio: 'Fish Audio', heygen: 'HeyGen', xfyun: '讯飞' }[form.provider]));
const showKey = ref(false);
const testText = ref('欢迎光临梦飞空间，张三消费 50 元，卡内余额 200 元');
const testStatus = ref('idle');
const testMessage = ref('');
const testMessageType = ref('success');
const isTesting = computed(() => testStatus.value === 'synthesizing');
const isPlaying = computed(() => testStatus.value === 'playing');

function showTestTip(text, type = 'success') {
  testMessage.value = text;
  testMessageType.value = type;
  showTip(text, type);
}
const isSaving = ref(false);
const message = ref('');
const messageType = ref('success');

const defaultUrl = computed(() => DEFAULTS[form.provider]?.apiUrl || '');
const defaultModel = computed(() => DEFAULTS[form.provider]?.model || '');
const defaultVoiceId = computed(() => DEFAULTS[form.provider]?.voiceId || '');

function showTip(text, type = 'success') {
  if (!alive) return;
  clearTimeout(tipTimer);
  message.value = text;
  messageType.value = type;
  tipTimer = setTimeout(() => {
    if (message.value === text) message.value = '';
  }, 5000);
}

function selectProvider(provider) {
  if (!isOwner.value || provider === form.provider) return;
  form.provider = provider;
  Object.assign(form, DEFAULTS[provider], { apiKey: '', appId: provider === 'xfyun' ? serverXfyunAppId.value : '' });
}

function toggleEnabled() {
  if (!isOwner.value || !loaded.value || isLoading.value || isSaving.value) return;
  form.enabled = !form.enabled;
}

function resetDefaultUrl() {
  form.apiUrl = DEFAULTS[form.provider]?.apiUrl || '';
}

function resetDefaultModel() {
  form.model = DEFAULTS[form.provider]?.model || '';
}

function resetDefaultVoiceId() {
  form.voiceId = DEFAULTS[form.provider]?.voiceId || '';
}


function insertVar(type, variable) {
  if (!isOwner.value) return;
  if (!form.templates[type]) form.templates[type] = '';
  form.templates[type] += variable;
}

async function loadConfig() {
  if (isSaving.value) return;
  const sequence = ++loadSequence;
  loaded.value = false; isLoading.value = true;
  try {
    const [data, users] = await Promise.all([props.api.getVoiceConfig(), isOwner.value ? props.api.getUsers() : []]);
    if (!alive || sequence !== loadSequence) return;
    if (!Object.hasOwn(DEFAULTS, data.provider || 'fish_audio')) throw new Error('语音服务商配置无效');
    form.enabled = Boolean(data.enabled);
    form.provider = data.provider || 'fish_audio';
    form.apiUrl = data.apiUrl || '';
    form.apiKey = '';
    form.appId = data.appId || '';
    serverXfyunAppId.value = data.appId || '';
    serverXfyunConfigured.value = Boolean(data.serverXfyunConfigured);
    form.model = data.model || DEFAULTS[form.provider].model;
    form.voiceId = data.voiceId || DEFAULTS[form.provider].voiceId;
    form.volume = typeof data.volume === 'number' ? data.volume : 1.0;
    form.events.consume = data.events?.consume !== false;
    form.events.recharge = data.events?.recharge !== false;
    form.templates.consume = data.templates?.consume ?? '{name} 消费 {amount} 元，卡内余额 {balance} 元';
    form.templates.recharge = data.templates?.recharge ?? '{name} 充值 {amount} 元，卡内余额 {balance} 元';
    hasSavedKey.value = Boolean(data.hasApiKey);
    savedKeyProvider.value = form.provider;
    ali.enabled = Boolean(data.aligenie?.enabled); ali.actorId = data.aligenie?.actorId || '';
    ali.token = ''; generatedSecret.value = ''; aliHasToken.value = Boolean(data.aligenie?.hasToken);
    aliDevices.value = (data.aligenie?.allowedDevices || []).join('\n');
    ali.verificationFile = data.aligenie?.verificationFile || '';
    ali.verificationContent = data.aligenie?.verificationContent || '';
    voiceActors.value = users.filter(user => user.active && user.role !== 'viewer');
    loaded.value = true;
  } catch (err) {
    if (alive && sequence === loadSequence) showTip('加载语音配置失败: ' + err.message, 'error');
  } finally {
    if (alive && sequence === loadSequence) isLoading.value = false;
  }
}

async function handleTestPlay() {
  if (!loaded.value || isSaving.value || testStatus.value !== 'idle') return;
  const sequence = ++previewSequence;
  if (!testText.value.trim()) {
    showTestTip('请输入需要试听的测试文本', 'error');
    return;
  }

  if (isOwner.value && !form.apiKey.trim() && !hasCurrentProviderKey.value) {
    showTestTip(form.provider === 'xfyun' ? '请先配置讯飞 APIPassword 后再试听' : '请先输入当前服务商的 API Key 后再试听', 'error');
    return;
  }

  if (isOwner.value && form.provider === 'xfyun' && !form.appId.trim()) {
    showTestTip('请先填写讯飞 APPID 后再试听', 'error'); return;
  }

  if (!isOwner.value && !form.enabled) {
    showTestTip('当前语音播报功能未启用，仅店主可试听草稿配置', 'error');
    return;
  }

  testStatus.value = 'synthesizing';
  testMessage.value = '';

  try {
    const dummyAudio = new Audio();
    dummyAudio.volume = 0;
    dummyAudio.play().catch(() => {});
  } catch {}

  try {
    await props.player.queueSpeak(testText.value.trim(), {
      volume: form.volume,
      testOptions: isOwner.value ? {
        provider: form.provider,
        apiUrl: form.apiUrl || defaultUrl.value,
        apiKey: form.apiKey,
        appId: form.appId,
        model: form.model || defaultModel.value,
        voiceId: form.voiceId || defaultVoiceId.value
      } : null,
      onStatus: status => {
        if (alive && sequence === previewSequence) testStatus.value = status;
      }
    });
    if (alive && sequence === previewSequence) showTestTip('音频合成并播放成功！', 'success');
  } catch (err) {
    if (alive && sequence === previewSequence && err.code !== 'VOICE_CANCELLED') showTestTip('试听失败: ' + err.message, 'error');
  } finally {
    if (alive && sequence === previewSequence) testStatus.value = 'idle';
  }
}

function handleStopPlay() {
  previewSequence++;
  props.player.stop();
  testStatus.value = 'idle';
  showTestTip('试听已停止', 'success');
}

async function handleSave() {
  if (!isOwner.value || !loaded.value || isLoading.value || isSaving.value) return;
  handleStopPlay();
  isSaving.value = true;
  message.value = '';

  try {
    const payload = {
      enabled: form.enabled,
      provider: form.provider,
      apiUrl: form.apiUrl.trim(),
      apiKey: form.apiKey.trim(),
      appId: form.appId.trim(),
      model: form.model.trim(),
      voiceId: form.voiceId.trim(),
      volume: form.volume,
      events: { ...form.events },
      aligenie: { ...ali, allowedDevices: aliDevices.value.split(/[,\n]/).map(value => value.trim()).filter(Boolean) },
      templates: {
        consume: form.templates.consume.trim(),
        recharge: form.templates.recharge.trim()
      }
    };

    const result = await props.api.saveVoiceConfig(payload);
    if (!alive) return;
    hasSavedKey.value = Boolean(result.hasApiKey);
    serverXfyunConfigured.value = Boolean(result.serverXfyunConfigured);
    serverXfyunAppId.value = result.appId || form.appId;
    savedKeyProvider.value = result.provider || form.provider;
    form.apiKey = ''; ali.token = ''; generatedSecret.value = ''; aliHasToken.value = Boolean(result.aligenie?.hasToken);
    props.player.stop();
    emit('saved', result);
    showTip('语音播报配置已成功保存！', 'success');
  } catch (err) {
    if (alive) showTip('保存配置失败: ' + err.message, 'error');
  } finally {
    isSaving.value = false;
  }
}

onMounted(() => {
  loadConfig();
});

onUnmounted(() => {
  alive = false; loadSequence++; previewSequence++; clearTimeout(tipTimer);
  props.player.stop();
});
</script>
