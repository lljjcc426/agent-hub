import {useRef} from 'react'
import {ComposerPrimitive, useAui, useAuiState} from '@assistant-ui/react'
import {ChatComposer, type ComposerActionsProps, type TextInputProps} from '../ui/chat-composer.tsx'

const RuntimeInput = (props: TextInputProps) => <ComposerPrimitive.Input {...props} submitMode="none"/>

export function ComposerControls(props: ComposerActionsProps) {
  const aui = useAui(), upload = useRef<HTMLButtonElement>(null)
  const canSend = useAuiState(s => !s.thread.isDisabled && s.composer.canSend)
  return <>
    <ComposerPrimitive.AddAttachment ref={upload} hidden tabIndex={-1} disabled={props.uploadDisabled} aria-label={props.L('Attach files','上传文件')}/>
    <ChatComposer {...props} Input={RuntimeInput} canSend={canSend} setText={text => aui.composer.setText(text)}
      onAttach={() => upload.current?.click()} onSend={() => aui.composer.send()}/>
  </>
}
